"""Lease-fenced delivery for private account messages; bearer URLs exist only in memory."""

import hmac
import smtplib
import uuid
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import delete, or_, select, update

from armeniabus.modules.bookings.lifecycle import database_now
from armeniabus.modules.users.actions import action_token, public_origin, token_hash
from armeniabus.modules.users.models import AuthAction, User, UserStatus


@dataclass
class AccountMessage:
    id: uuid.UUID
    recipient_email: str
    subject: str
    body: str


def account_message(item, settings) -> AccountMessage:
    if item.purpose == "PASSWORD_CHANGED":
        return AccountMessage(
            item.id,
            item.recipient_email,
            "armatrans: пароль изменён",
            "Пароль вашего аккаунта armatrans изменён. Старые сессии завершены.\n"
            "Если вы этого не делали, запросите восстановление доступа "
            "и обратитесь в support@mathbot.site.\n",
        )
    token = action_token(item.id, item.purpose, settings)
    if not hmac.compare_digest(item.token_hash or "", token_hash(token)):
        raise ValueError("TOKEN_KEY_CHANGED")
    reset = item.purpose == "RESET"
    path = "reset-password" if reset else "verify-email"
    url = f"{public_origin(settings)}/{path}#token={token}"
    subject = "armatrans: восстановление пароля" if reset else "armatrans: подтвердите почту"
    body = (
        "Чтобы задать новый пароль, откройте ссылку:"
        if reset
        else "Чтобы подтвердить почту аккаунта, откройте ссылку:"
    )
    duration = "30 минут" if reset else "24 часа"
    body += f"\n{url}\n\nСсылка одноразовая, действует {duration} с момента запроса.\n"
    body += (
        "Если вы не запрашивали это письмо, ничего делать не нужно. "
        "Не пересылайте ссылку другим людям.\nПоддержка: support@mathbot.site\n"
    )
    return AccountMessage(item.id, item.recipient_email, subject, body)


async def deliver_account_batch(sessions, sender, settings) -> int:
    if not settings.notifications_enabled:
        return 0
    delivered = 0
    for _ in range(settings.notification_batch_size):
        async with sessions() as db:
            now = await database_now(db)
            item = await db.scalar(
                select(AuthAction)
                .where(
                    AuthAction.mail_status == "PENDING",
                    AuthAction.next_attempt_at <= now,
                    or_(AuthAction.lease_until.is_(None), AuthAction.lease_until <= now),
                )
                .order_by(AuthAction.created_at, AuthAction.id)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
            if item is None:
                break
            user = await db.get(User, item.user_id)
            if (
                item.used_at
                or item.expires_at <= now
                or not user
                or user.status != UserStatus.ACTIVE
                or user.email != item.recipient_email
                or item.attempts >= settings.notification_max_attempts
            ):
                item.mail_status = "FAILED"
                item.last_error = "EXPIRED_USED_OR_UNAVAILABLE"
                item.lease_token = item.lease_until = None
                await db.commit()
                continue
            lease = uuid.uuid4()
            item.lease_token = lease
            item.lease_until = now + timedelta(seconds=120)
            item.attempts += 1
            await db.commit()
        error = None
        try:
            await sender.send(account_message(item, settings))
        except ValueError:
            error = "TOKEN_KEY_CHANGED"
        except (smtplib.SMTPException, OSError, TimeoutError) as exc:
            error = type(exc).__name__
        async with sessions() as db:
            now = await database_now(db)
            values = dict(lease_until=None, lease_token=None, last_error=error)
            if error:
                values.update(
                    mail_status="FAILED"
                    if error == "TOKEN_KEY_CHANGED"
                    or item.attempts >= settings.notification_max_attempts
                    else "PENDING",
                    next_attempt_at=now
                    + timedelta(
                        seconds=min(
                            3600, settings.notification_retry_seconds * 2 ** (item.attempts - 1)
                        )
                    ),
                )
            else:
                values.update(mail_status="SENT", sent_at=now)
            result = await db.execute(
                update(AuthAction)
                .where(
                    AuthAction.id == item.id,
                    AuthAction.lease_token == lease,
                    AuthAction.mail_status == "PENDING",
                )
                .values(**values)
            )
            await db.commit()
            delivered += bool(result.rowcount and not error)
    async with sessions() as db:
        now = await database_now(db)
        old_ids = (
            select(AuthAction.id).where(AuthAction.expires_at < now - timedelta(days=30)).limit(100)
        )
        await db.execute(delete(AuthAction).where(AuthAction.id.in_(old_ids)))
        await db.commit()
    return delivered
