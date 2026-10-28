import uuid
from collections.abc import Callable
from typing import Annotated

import jwt
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.errors import ApiError
from armeniabus.infrastructure.db.session import get_db_session
from armeniabus.modules.users.models import User, UserRole, UserStatus

bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> User:
    if not credentials:
        raise ApiError(401, "UNAUTHORIZED", "Authentication required")
    settings = request.app.state.settings
    try:
        payload = jwt.decode(
            credentials.credentials,
            settings.jwt_secret_key.get_secret_value(),
            algorithms=["HS256"],
            audience="armeniabus-api",
            issuer="armeniabus",
            options={"require": ["sub", "iat", "exp", "jti"]},
        )
        if payload.get("typ") != "access":
            raise ValueError("Wrong token type")
        user_id = uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, ValueError, KeyError, TypeError):
        raise ApiError(401, "INVALID_ACCESS_TOKEN", "Access token is invalid") from None
    user = await db.get(User, user_id)
    if not user:
        raise ApiError(401, "INVALID_ACCESS_TOKEN", "Access token is invalid")
    if type(payload.get("ver", 0)) is not int or payload.get("ver", 0) != user.auth_version:
        raise ApiError(401, "INVALID_ACCESS_TOKEN", "Access token is invalid")
    if user.status != UserStatus.ACTIVE:
        raise ApiError(403, "USER_BLOCKED", "User account is blocked")
    return user


def require_role(*roles: UserRole) -> Callable:
    async def check_role(user: Annotated[User, Depends(get_current_user)]) -> User:
        if user.role not in roles:
            raise ApiError(403, "FORBIDDEN", "You do not have access to this resource")
        return user

    return check_role
