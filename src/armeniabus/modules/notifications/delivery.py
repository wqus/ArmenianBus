import asyncio
import smtplib
import ssl
import uuid
from datetime import timedelta
from email.message import EmailMessage

from sqlalchemy import or_, select, update

from armeniabus.core.config import Settings
from armeniabus.modules.bookings.lifecycle import database_now
from armeniabus.modules.notifications.models import Notification


class SmtpSender:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def send(self, notification: Notification):
        await asyncio.to_thread(self._send, notification)

    def _send(self, notification):
        config = self.settings
        message = EmailMessage()
        message["From"] = str(config.smtp_from)
        message["To"] = notification.recipient_email
        message["Subject"] = notification.subject
        message["Message-ID"] = f"<{notification.id}@{str(config.smtp_from).split('@')[1]}>"
        message.set_content(notification.body)
        with smtplib.SMTP_SSL(
            config.smtp_host, config.smtp_port, timeout=10, context=ssl.create_default_context()
        ) as smtp:
            if config.smtp_username:
                smtp.login(config.smtp_username, config.smtp_password.get_secret_value())
            refused = smtp.send_message(message)
            if refused:
                raise smtplib.SMTPRecipientsRefused(refused)


async def deliver_batch(sessions, sender, settings: Settings) -> int:
    if not settings.notifications_enabled:
        return 0
    delivered = 0
    for _ in range(settings.notification_batch_size):
        async with sessions() as db:
            now = await database_now(db)
            item = await db.scalar(
                select(Notification)
                .where(
                    Notification.status == "PENDING",
                    Notification.next_attempt_at <= now,
                    or_(Notification.lease_until.is_(None), Notification.lease_until <= now),
                )
                .order_by(Notification.created_at, Notification.id)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
            if item is None:
                break
            if item.attempts >= settings.notification_max_attempts:
                item.status = "FAILED"
                item.last_error = "ATTEMPT_LIMIT"
                item.lease_until = item.lease_token = None
                await db.commit()
                continue
            token = uuid.uuid4()
            item.lease_token = token
            item.lease_until = now + timedelta(seconds=120)
            item.attempts += 1
            await db.commit()
        error = None
        try:
            await sender.send(item)
        except (smtplib.SMTPException, OSError, TimeoutError) as exc:
            error = type(exc).__name__  # Never store recipients, credentials or SMTP response text.
        async with sessions() as db:
            now = await database_now(db)
            values = {"lease_until": None, "lease_token": None, "last_error": error}
            if error:
                values.update(
                    status="FAILED"
                    if item.attempts >= settings.notification_max_attempts
                    else "PENDING",
                    next_attempt_at=now
                    + timedelta(
                        seconds=min(
                            3600, settings.notification_retry_seconds * 2 ** (item.attempts - 1)
                        )
                    ),
                )
            else:
                values.update(status="SENT", sent_at=now)
            result = await db.execute(
                update(Notification)
                .where(
                    Notification.id == item.id,
                    Notification.lease_token == token,
                    Notification.status == "PENDING",
                )
                .values(**values)
            )
            await db.commit()
            delivered += bool(result.rowcount and not error)
    return delivered
