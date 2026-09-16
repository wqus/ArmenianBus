import asyncio
import os
import smtplib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from armeniabus.core.config import Settings
from armeniabus.infrastructure.db.session import create_session_factory
from armeniabus.modules.bookings.models import Booking
from armeniabus.modules.notifications.delivery import deliver_batch
from armeniabus.modules.notifications.models import Notification
from armeniabus.modules.notifications.outbox import enqueue
from tests.test_bookings_integration import held
from tests.test_bookings_integration import trip as trip
from tests.test_carriers_integration import world as world
from tests.test_routes_integration import journeys as journeys

pytestmark = pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test PostgreSQL")


class Sender:
    def __init__(self):
        self.calls = []
        self.fail = False

    async def send(self, item):
        self.calls.append(item.id)
        await asyncio.sleep(0.02)
        if self.fail:
            raise smtplib.SMTPException("sensitive-address@example.com private SMTP response")


async def prepare(sessions, booking):
    async with sessions() as db:
        row = await db.get(Booking, uuid.UUID(booking["id"]))
        await enqueue(db, row, "paid")
        await db.commit()
        return await db.scalar(select(Notification.id).where(Notification.booking_id == row.id))


def config(**options):
    return Settings(
        notifications_enabled=True,
        smtp_host="smtp.invalid",
        smtp_from="sender@example.com",
        notification_batch_size=1,
        **options,
    )


def test_notification_disabled_then_two_workers_send_once(trip):
    booking = held(trip)

    async def exercise():
        settings = config()
        engine, sessions = create_session_factory(settings.database_url)
        sender = Sender()
        try:
            notification_id = await prepare(sessions, booking)
            settings.notifications_enabled = False
            assert await deliver_batch(sessions, sender, settings) == 0
            assert sender.calls == []
            async with sessions() as db:
                assert (await db.get(Notification, notification_id)).attempts == 0
            settings.notifications_enabled = True
            results = await asyncio.gather(
                deliver_batch(sessions, sender, settings), deliver_batch(sessions, sender, settings)
            )
            assert sum(results) == 1 and sender.calls == [notification_id]
            assert await deliver_batch(sessions, sender, settings) == 0
            async with sessions() as db:
                row = await db.get(Notification, notification_id)
                assert row.status == "SENT" and row.sent_at and row.attempts == 1
                assert row.lease_token is None and row.lease_until is None
        finally:
            await engine.dispose()

    asyncio.run(exercise())


def test_notification_backoff_exhaustion_and_sanitized_errors(trip):
    booking = held(trip)

    async def exercise():
        settings = config(notification_max_attempts=2)
        engine, sessions = create_session_factory(settings.database_url)
        sender = Sender()
        sender.fail = True
        try:
            notification_id = await prepare(sessions, booking)
            assert await deliver_batch(sessions, sender, settings) == 0
            async with sessions() as db:
                row = await db.get(Notification, notification_id)
                assert row.status == "PENDING" and row.attempts == 1
                assert row.last_error == "SMTPException"
                assert row.next_attempt_at > datetime.now(UTC)
            assert await deliver_batch(sessions, sender, settings) == 0
            assert len(sender.calls) == 1
            async with sessions() as db:
                await db.execute(
                    update(Notification)
                    .where(Notification.id == notification_id)
                    .values(next_attempt_at=datetime.now(UTC) - timedelta(seconds=1))
                )
                await db.commit()
            assert await deliver_batch(sessions, sender, settings) == 0
            async with sessions() as db:
                row = await db.get(Notification, notification_id)
                assert row.status == "FAILED" and row.attempts == 2
            assert await deliver_batch(sessions, sender, settings) == 0
            assert len(sender.calls) == 2
        finally:
            await engine.dispose()

    asyncio.run(exercise())


def test_expired_lease_recovers_and_old_attempt_cannot_overwrite_new_owner(trip):
    booking = held(trip)

    async def exercise():
        settings = config()
        engine, sessions = create_session_factory(settings.database_url)
        replacement_token = uuid.uuid4()
        try:
            notification_id = await prepare(sessions, booking)
            async with sessions() as db:
                await db.execute(
                    update(Notification)
                    .where(Notification.id == notification_id)
                    .values(
                        lease_until=datetime.now(UTC) - timedelta(seconds=1),
                        lease_token=uuid.uuid4(),
                        attempts=1,
                    )
                )
                await db.commit()

            class ReclaimedSender:
                async def send(self, item):
                    # Simulate a new worker acquiring an expired lease before the old one returns.
                    async with sessions() as db:
                        await db.execute(
                            update(Notification)
                            .where(Notification.id == item.id)
                            .values(
                                lease_token=replacement_token,
                                lease_until=datetime.now(UTC) + timedelta(minutes=2),
                            )
                        )
                        await db.commit()

            assert await deliver_batch(sessions, ReclaimedSender(), settings) == 0
            async with sessions() as db:
                row = await db.get(Notification, notification_id)
                assert row.status == "PENDING" and row.attempts == 2
                assert row.lease_token == replacement_token and row.sent_at is None
                row.lease_until = datetime.now(UTC) - timedelta(seconds=1)
                await db.commit()
            sender = Sender()
            assert await deliver_batch(sessions, sender, settings) == 1
            assert sender.calls == [notification_id]
        finally:
            await engine.dispose()

    asyncio.run(exercise())
