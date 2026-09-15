import uuid
from datetime import UTC, datetime, timedelta

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.errors import ApiError
from armeniabus.core.config import Settings
from armeniabus.core.security import (
    create_access_token,
    create_refresh_token,
    hash_password,
    refresh_token_hash,
    verify_password,
)
from armeniabus.modules.users.models import RefreshSession, User, UserStatus
from armeniabus.modules.users.schemas import LoginInput, RegisterInput, TokenPair


def normalized_email(email: str) -> str:
    return email.strip().lower()


def new_refresh_session(user_id: uuid.UUID, settings: Settings) -> tuple[RefreshSession, str]:
    token = create_refresh_token()
    session = RefreshSession(
        user_id=user_id,
        token_hash=refresh_token_hash(token),
        expires_at=datetime.now(UTC) + timedelta(days=settings.refresh_token_ttl_days),
    )
    return session, token


def token_pair(user_id: uuid.UUID, refresh_token: str, settings: Settings) -> TokenPair:
    return TokenPair(
        access_token=create_access_token(user_id, settings),
        refresh_token=refresh_token,
        expires_in=settings.access_token_ttl_minutes * 60,
    )


async def register_user(db: AsyncSession, data: RegisterInput) -> User:
    user = User(
        email=normalized_email(str(data.email)),
        password_hash=await run_in_threadpool(hash_password, data.password),
        role=data.role.value,
        status=UserStatus.ACTIVE,
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise ApiError(409, "EMAIL_EXISTS", "Email is already registered") from None
    await db.refresh(user)
    return user


async def login_user(db: AsyncSession, data: LoginInput, settings: Settings) -> TokenPair:
    user = await db.scalar(select(User).where(User.email == normalized_email(str(data.email))))
    valid_password = await run_in_threadpool(
        verify_password, data.password, user.password_hash if user else None
    )
    if not user or not valid_password:
        raise ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password")
    if user.status != UserStatus.ACTIVE:
        raise ApiError(403, "USER_BLOCKED", "User account is blocked")
    session, refresh_token = new_refresh_session(user.id, settings)
    db.add(session)
    await db.commit()
    return token_pair(user.id, refresh_token, settings)


async def rotate_refresh_token(db: AsyncSession, token: str, settings: Settings) -> TokenPair:
    session = await db.scalar(
        select(RefreshSession)
        .where(RefreshSession.token_hash == refresh_token_hash(token))
        .with_for_update()
    )
    now = datetime.now(UTC)
    if not session or session.revoked_at or session.expires_at <= now:
        raise ApiError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid")
    user = await db.get(User, session.user_id)
    if not user or user.status != UserStatus.ACTIVE:
        raise ApiError(403, "USER_BLOCKED", "User account is blocked")
    session.revoked_at = now
    replacement, refresh_token = new_refresh_session(user.id, settings)
    db.add(replacement)
    await db.commit()
    return token_pair(user.id, refresh_token, settings)


async def revoke_refresh_token(db: AsyncSession, token: str) -> None:
    session = await db.scalar(
        select(RefreshSession)
        .where(RefreshSession.token_hash == refresh_token_hash(token))
        .with_for_update()
    )
    if session and session.revoked_at is None:
        session.revoked_at = datetime.now(UTC)
        await db.commit()
