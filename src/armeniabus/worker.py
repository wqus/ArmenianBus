"""PostgreSQL hold expiry worker; independent of Redis and API processes."""

import argparse
import asyncio
import logging

from sqlalchemy.exc import SQLAlchemyError

from armeniabus.core.config import Settings
from armeniabus.core.logging import configure_logging
from armeniabus.infrastructure.db import models  # noqa: F401
from armeniabus.infrastructure.db.session import create_session_factory
from armeniabus.modules.admin.monitoring import heartbeat
from armeniabus.modules.bookings.lifecycle import expire_batch

logger = logging.getLogger(__name__)


async def run(once: bool) -> int:
    settings = Settings()
    configure_logging(settings.log_level)
    engine, sessions = create_session_factory(settings.database_url)
    logger.info("Hold expiry worker started")
    try:
        while True:
            try:
                async with sessions() as db:
                    count = await expire_batch(db, settings.hold_worker_batch_size)
                await heartbeat(sessions, "holds", count=count)
                if count or once:
                    logger.info("Expired holds: %s", count)
            except (SQLAlchemyError, OSError, TimeoutError) as exc:
                # Exception messages may contain connection details; log only the type.
                logger.error("Hold expiry batch failed: %s", type(exc).__name__)
                try:
                    await heartbeat(sessions, "holds", error=type(exc).__name__)
                except (SQLAlchemyError, OSError, TimeoutError):
                    pass
                if once:
                    return 1
            if once:
                return 0
            await asyncio.sleep(settings.hold_worker_interval_seconds)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Expire overdue booking holds")
    parser.add_argument("--once", action="store_true", help="Process one bounded batch and exit")
    args = parser.parse_args()
    try:
        raise SystemExit(asyncio.run(run(args.once)))
    except KeyboardInterrupt:
        pass
