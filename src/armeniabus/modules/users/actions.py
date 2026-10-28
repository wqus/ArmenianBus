"""Private one-time email actions. Links are derived in memory, never stored as bearers."""

import hashlib
import hmac
import re
import uuid
from datetime import timedelta
from urllib.parse import urlsplit

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import func, select, update

from armeniabus.api.errors import ApiError
from armeniabus.core.config import Settings
from armeniabus.core.security import hash_password
from armeniabus.modules.admin.audit import record_audit
from armeniabus.modules.bookings.lifecycle import database_now
from armeniabus.modules.users.models import AuthAction, RefreshSession, User, UserStatus

TOKEN = re.compile(r"^[0-9a-f]{32}\.[0-9a-f]{64}$")


def action_token(action_id: uuid.UUID, purpose: str, settings: Settings) -> str:
    # UUID4 supplies a fresh random selector; a purpose-separated 256-bit MAC is the secret.
    digest = hmac.new(
        settings.jwt_secret_key.get_secret_value().encode(),
        f"armatrans:email-action:v1:{purpose}:{action_id.hex}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"{action_id.hex}.{digest}"


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def public_origin(settings: Settings) -> str:
    parsed = urlsplit(str(settings.auth_public_origin or settings.payment_return_url))
    return f"{parsed.scheme}://{parsed.netloc}"


async def enqueue_action(db, user: User, purpose: str, settings: Settings) -> AuthAction | None:
    now = await database_now(db)
    if purpose != "PASSWORD_CHANGED":
        latest, count = (
            await db.execute(
                select(func.max(AuthAction.created_at), func.count()).where(
                    AuthAction.user_id == user.id,
                    AuthAction.purpose == purpose,
                    AuthAction.created_at > now - timedelta(hours=1),
                )
            )
        ).one()
        # Do not invalidate older links on a new request: that would allow account DoS.
        if count >= 5 or (latest and latest > now - timedelta(seconds=60)):
            return None
    action_id = uuid.uuid4()
    action = AuthAction(
        id=action_id,
        user_id=user.id,
        purpose=purpose,
        recipient_email=user.email,
        token_hash=token_hash(action_token(action_id, purpose, settings))
        if purpose != "PASSWORD_CHANGED"
        else None,
        created_at=now,
        next_attempt_at=now,
        expires_at=now + timedelta(minutes=30 if purpose == "RESET" else 1440),
    )
    db.add(action)
    await db.flush()
    return action


def require_mail(settings: Settings) -> None:
    if not settings.notifications_enabled:
        raise ApiError(503, "ACCOUNT_MAIL_UNAVAILABLE", "Account mail is not available")


async def request_reset(db, email: str, settings: Settings) -> None:
    require_mail(settings)
    user = await db.scalar(
        select(User).where(User.email == email.strip().lower()).with_for_update()
    )
    if user and user.status == UserStatus.ACTIVE:
        await enqueue_action(db, user, "RESET", settings)
    await db.commit()


async def request_verification(db, user: User, settings: Settings) -> None:
    require_mail(settings)
    user = await db.scalar(
        select(User)
        .where(User.id == user.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if user.status == UserStatus.ACTIVE and not user.email_verified_at:
        await enqueue_action(db, user, "VERIFY", settings)
    await db.commit()


async def consume_action(
    db, token: str, purpose: str, settings: Settings, password: str | None = None
) -> None:
    def invalid():
        return ApiError(400, "ACTION_LINK_INVALID", "Link is invalid, expired or already used")

    if not TOKEN.fullmatch(token):
        raise invalid()
    action_id = uuid.UUID(hex=token.split(".")[0])
    if not hmac.compare_digest(token, action_token(action_id, purpose, settings)):
        raise invalid()
    user_id = await db.scalar(
        select(AuthAction.user_id).where(AuthAction.id == action_id, AuthAction.purpose == purpose)
    )
    if user_id is None:
        raise invalid()
    # Same lock order as login/refresh/block: user, then action/session rows.
    user = await db.scalar(
        select(User)
        .where(User.id == user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    action = await db.scalar(
        select(AuthAction)
        .where(AuthAction.id == action_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    now = await database_now(db)
    if (
        not user
        or user.status != UserStatus.ACTIVE
        or not action
        or action.recipient_email != user.email
        or action.used_at
        or action.expires_at <= now
        or not hmac.compare_digest(action.token_hash or "", token_hash(token))
    ):
        raise invalid()
    action.used_at = now
    if purpose == "RESET":
        if password is None:
            raise invalid()
        user.password_hash = await run_in_threadpool(hash_password, password)
        user.auth_version += 1
        await db.execute(
            update(RefreshSession)
            .where(RefreshSession.user_id == user.id, RefreshSession.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        await db.execute(
            update(AuthAction)
            .where(
                AuthAction.user_id == user.id,
                AuthAction.purpose == "RESET",
                AuthAction.used_at.is_(None),
            )
            .values(used_at=now)
        )
        await enqueue_action(db, user, "PASSWORD_CHANGED", settings)
        record_audit(db, user.id, "user.password_reset", "user", user.id)
    else:
        if not user.email_verified_at:
            user.email_verified_at = now
        await db.execute(
            update(AuthAction)
            .where(
                AuthAction.user_id == user.id,
                AuthAction.purpose == "VERIFY",
                AuthAction.used_at.is_(None),
            )
            .values(used_at=now)
        )
        record_audit(db, user.id, "user.email_verified", "user", user.id)
    await db.commit()
