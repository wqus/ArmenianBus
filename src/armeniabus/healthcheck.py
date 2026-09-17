"""Exit nonzero when a worker heartbeat is missing, stale, or failed."""

import argparse
import asyncio

from sqlalchemy import func, select

from armeniabus.core.config import Settings
from armeniabus.infrastructure.db.session import create_session_factory
from armeniabus.modules.admin.monitoring import WORKERS, WorkerHeartbeat, worker_state


async def check(name):
    settings = Settings()
    engine, sessions = create_session_factory(settings.database_url)
    try:
        async with sessions() as db:
            now = await db.scalar(select(func.clock_timestamp()))
            row = await db.get(WorkerHeartbeat, name)
            state = worker_state(row, now, settings.worker_stale_seconds)
            print(f"{name}: {state}")
            return 0 if state in {"OK", "DISABLED"} else 1
    finally:
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("worker", choices=WORKERS)
    args = parser.parse_args()
    try:
        raise SystemExit(asyncio.run(asyncio.wait_for(check(args.worker), timeout=5)))
    except Exception as exc:
        print(f"Worker check unavailable: {type(exc).__name__}")
        raise SystemExit(1) from None
