"""Deliver durable notification outbox entries independently of API requests."""

import argparse
import asyncio
import logging

from sqlalchemy.exc import SQLAlchemyError

from armeniabus.core.config import Settings
from armeniabus.core.logging import configure_logging
from armeniabus.infrastructure.db import models  # noqa: F401
from armeniabus.infrastructure.db.session import create_session_factory
from armeniabus.modules.admin.monitoring import heartbeat
from armeniabus.modules.notifications.delivery import SmtpSender, deliver_batch
from armeniabus.modules.users.mail import deliver_account_batch

logger = logging.getLogger(__name__)


async def run(once: bool) -> int:
    settings = Settings()
    configure_logging(settings.log_level)
    engine, sessions = create_session_factory(settings.database_url)
    sender = SmtpSender(settings)
    logger.info("Notification worker started; enabled=%s", settings.notifications_enabled)
    try:
        while True:
            try:
                count = await deliver_batch(sessions, sender, settings)
                count += await deliver_account_batch(sessions, sender, settings)
                await heartbeat(
                    sessions, "notifications", enabled=settings.notifications_enabled, count=count
                )
                if count or once:
                    logger.info("Delivered notifications: %s", count)
            except (SQLAlchemyError, OSError, TimeoutError) as exc:
                logger.error("Notification batch failed: %s", type(exc).__name__)
                try:
                    await heartbeat(
                        sessions,
                        "notifications",
                        enabled=settings.notifications_enabled,
                        error=type(exc).__name__,
                    )
                except (SQLAlchemyError, OSError, TimeoutError):
                    pass
                if once:
                    return 1
            if once:
                return 0
            await asyncio.sleep(settings.notification_poll_seconds)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Deliver booking notifications via SMTP over TLS")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    try:
        raise SystemExit(asyncio.run(run(args.once)))
    except KeyboardInterrupt:
        pass
