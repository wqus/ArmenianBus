from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.dependencies import get_current_user
from armeniabus.api.errors import ErrorBody
from armeniabus.api.rate_limit import enforce_auth_rate_limit
from armeniabus.infrastructure.db.session import get_db_session
from armeniabus.modules.users.models import User
from armeniabus.modules.users.schemas import (
    LoginInput,
    LogoutInput,
    RefreshInput,
    RegisterInput,
    TokenPair,
    UserPublic,
)
from armeniabus.modules.users.service import (
    login_user,
    register_user,
    revoke_refresh_token,
    rotate_refresh_token,
)

router = APIRouter(tags=["auth"])
DbSession = Annotated[AsyncSession, Depends(get_db_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.post(
    "/api/v1/auth/register",
    status_code=201,
    response_model=UserPublic,
    responses={409: {"model": ErrorBody}, 429: {"model": ErrorBody}},
)
async def register(request: Request, data: RegisterInput, db: DbSession) -> User:
    await enforce_auth_rate_limit(request, "register")
    return await register_user(db, data)


@router.post(
    "/api/v1/auth/login",
    response_model=TokenPair,
    responses={401: {"model": ErrorBody}, 403: {"model": ErrorBody}, 429: {"model": ErrorBody}},
)
async def login(request: Request, data: LoginInput, db: DbSession) -> TokenPair:
    await enforce_auth_rate_limit(request, "login", str(data.email).lower())
    return await login_user(db, data, request.app.state.settings)


@router.post(
    "/api/v1/auth/refresh",
    response_model=TokenPair,
    responses={401: {"model": ErrorBody}, 403: {"model": ErrorBody}, 429: {"model": ErrorBody}},
)
async def refresh(request: Request, data: RefreshInput, db: DbSession) -> TokenPair:
    await enforce_auth_rate_limit(request, "refresh")
    return await rotate_refresh_token(db, data.refresh_token, request.app.state.settings)


@router.post("/api/v1/auth/logout", status_code=204)
async def logout(data: LogoutInput, db: DbSession) -> None:
    await revoke_refresh_token(db, data.refresh_token)


@router.get(
    "/api/v1/me",
    response_model=UserPublic,
    responses={401: {"model": ErrorBody}, 403: {"model": ErrorBody}},
)
async def me(user: CurrentUser) -> User:
    return user
