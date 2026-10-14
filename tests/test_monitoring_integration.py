import asyncio
import os
from datetime import timedelta

import pytest
from sqlalchemy import delete, func, select, text, update

from armeniabus.core.config import Settings
from armeniabus.healthcheck import check
from armeniabus.infrastructure.db.session import create_session_factory
from armeniabus.modules.admin.monitoring import WORKERS, WorkerHeartbeat, heartbeat, worker_state
from tests.test_carriers_integration import world  # noqa: F401

pytestmark = pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test PostgreSQL")


def test_heartbeat_failure_recovery_disabled_and_staleness():
    async def scenario():
        engine, sessions = create_session_factory(Settings().database_url)
        try:
            await heartbeat(sessions, "test-worker", count=3)
            assert await check("test-worker") == 0
            async with sessions() as db:
                first = await db.get(WorkerHeartbeat, "test-worker")
                success_at = first.last_success_at
                assert first.last_count == 3
            await heartbeat(sessions, "test-worker", error="TimeoutError")
            assert await check("test-worker") == 1
            async with sessions() as db:
                failed = await db.get(WorkerHeartbeat, "test-worker")
                now = await db.scalar(select(func.clock_timestamp()))
                assert failed.last_success_at == success_at
                assert worker_state(failed, now, 600) == "ERROR"
            await heartbeat(sessions, "test-worker", enabled=False)
            assert await check("test-worker") == 0
            async with sessions() as db:
                recovered = await db.get(WorkerHeartbeat, "test-worker")
                assert recovered.last_error is None
                assert worker_state(recovered, recovered.last_seen_at, 600) == "DISABLED"
                assert (
                    worker_state(recovered, recovered.last_seen_at + timedelta(seconds=601), 600)
                    == "STALE"
                )
                assert worker_state(None, now, 600) == "MISSING"
                await db.execute(
                    update(WorkerHeartbeat)
                    .where(WorkerHeartbeat.name == "test-worker")
                    .values(last_seen_at=func.clock_timestamp() - text("interval '3 hours'"))
                )
                await db.commit()
            assert await check("test-worker") == 1
            assert await check("absent-test-worker") == 1
        finally:
            async with sessions() as db:
                await db.execute(
                    delete(WorkerHeartbeat).where(WorkerHeartbeat.name == "test-worker")
                )
                await db.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_operations_health_requires_admin_and_reports_stale_worker(world):  # noqa: F811
    engine, sessions = create_session_factory(Settings().database_url)

    async def prepare():
        await heartbeat(sessions, "notifications", enabled=False)
        async with sessions() as db:
            await db.execute(
                update(WorkerHeartbeat)
                .where(WorkerHeartbeat.name == "notifications")
                .values(last_seen_at=func.clock_timestamp() - text("interval '20 minutes'"))
            )
            await db.commit()
        await engine.dispose()

    asyncio.run(prepare())
    try:
        client = world.client
        url = "/api/v1/admin/operations/health"
        assert client.get(url).status_code == 401
        _, passenger = world.account("PASSENGER")
        assert client.get(url, headers=passenger).status_code == 403
        response = client.get(url, headers=world.admin)
        assert response.status_code == 200, response.text
        data = response.json()
        assert {row["name"] for row in data["workers"]} == set(WORKERS)
        notification = next(row for row in data["workers"] if row["name"] == "notifications")
        assert notification["state"] == "STALE"
        assert all(
            value >= 0
            for key, value in data["queues"].items()
            if key != "oldest_notification_due_at"
        )
        assert "smtp" not in response.text.lower()
    finally:

        async def cleanup():
            async with sessions() as db:
                await db.execute(
                    delete(WorkerHeartbeat).where(WorkerHeartbeat.name == "notifications")
                )
                await db.commit()
            await engine.dispose()

        asyncio.run(cleanup())


def test_admin_audit_index_supports_large_recent_event_list():
    async def scenario():
        engine, _ = create_session_factory(Settings().database_url)
        try:
            async with engine.connect() as db:
                transaction = await db.begin()
                try:
                    await db.execute(
                        text("""
                        INSERT INTO audit_log
                            (id, entity_type, entity_id, action, metadata, created_at)
                        SELECT gen_random_uuid(), 'probe', gen_random_uuid(), 'probe', '{}',
                               now() - n * interval '1 second'
                        FROM generate_series(1, 20000) AS n
                    """)
                    )
                    await db.execute(text("ANALYZE audit_log"))
                    plan = await db.scalar(
                        text("""EXPLAIN (FORMAT JSON, ANALYZE)
                        SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 20
                    """)
                    )
                    assert "ix_audit_log_created" in str(plan)
                    assert plan[0]["Plan"]["Actual Rows"] == 20
                finally:
                    await transaction.rollback()
        finally:
            await engine.dispose()

    asyncio.run(scenario())
