"""Reconcile payment intents independently of the hold expiry worker."""

import argparse
import asyncio
import logging

from sqlalchemy.exc import SQLAlchemyError

from armeniabus.core.config import Settings
from armeniabus.core.logging import configure_logging
from armeniabus.infrastructure.db import models  # noqa: F401
from armeniabus.infrastructure.db.session import create_session_factory
from armeniabus.modules.admin.monitoring import heartbeat
from armeniabus.modules.payments.provider import YooKassa
from armeniabus.modules.payments.service import reconcile_batch

logger = logging.getLogger(__name__)


async def run(once: bool) -> int:
    settings = Settings()
    configure_logging(settings.log_level)
    engine, sessions = create_session_factory(settings.database_url)
    provider = YooKassa(settings)
    logger.info("Payment worker started; enabled=%s", settings.payments_enabled)
    try:
        while True:
            try:
                count = await reconcile_batch(sessions, provider, settings)
                await heartbeat(
                    sessions, "payments", enabled=settings.payments_enabled, count=count
                )
                if count or once:
                    logger.info("Reconciled payments: %s", count)
            except (SQLAlchemyError, OSError, TimeoutError) as exc:
                logger.error("Payment batch failed: %s", type(exc).__name__)
                try:
                    await heartbeat(
                        sessions,
                        "payments",
                        enabled=settings.payments_enabled,
                        error=type(exc).__name__,
                    )
                except (SQLAlchemyError, OSError, TimeoutError):
                    pass
                if once:
                    return 1
            if once:
                return 0
            await asyncio.sleep(settings.payment_poll_seconds)
    finally:
        await provider.close()
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Reconcile pending payments with YooKassa")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    try:
        raise SystemExit(asyncio.run(run(args.once)))
    except KeyboardInterrupt:
        pass
