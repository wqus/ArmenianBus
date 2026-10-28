import asyncio
import secrets
import time
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.dependencies import get_current_user
from armeniabus.api.rate_limit import enforce_auth_rate_limit
from armeniabus.infrastructure.db.session import get_db_session
from armeniabus.modules.users.actions import consume_action, request_reset, request_verification
from armeniabus.modules.users.models import User
from armeniabus.modules.users.schemas import (
    ActionTokenInput,
    ForgotPasswordInput,
    ResetPasswordInput,
)

router = APIRouter(prefix="/api/v1/auth", tags=["account-actions"])
DbSession = Annotated[AsyncSession, Depends(get_db_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.post("/forgot-password", status_code=202)
async def forgot(request: Request, data: ForgotPasswordInput, db: DbSession):
    await enforce_auth_rate_limit(request, "forgot-password", str(data.email).lower())
    started = time.monotonic()
    target = 0.3 + secrets.randbelow(101) / 1000
    try:
        await request_reset(db, str(data.email), request.app.state.settings)
    finally:
        await asyncio.sleep(max(0, target - (time.monotonic() - started)))
    return {"message": "If the account is available, a recovery email will be sent"}


@router.post("/reset-password", status_code=204)
async def reset(request: Request, data: ResetPasswordInput, db: DbSession):
    await enforce_auth_rate_limit(request, "reset-password")
    await consume_action(db, data.token, "RESET", request.app.state.settings, data.password)


@router.post("/verification/request", status_code=202)
async def verification_request(request: Request, user: CurrentUser, db: DbSession):
    await enforce_auth_rate_limit(request, "verification-request", str(user.id))
    await request_verification(db, user, request.app.state.settings)
    return {"message": "Verification email queued if needed"}


@router.post("/verify-email", status_code=204)
async def verify(request: Request, data: ActionTokenInput, db: DbSession):
    await enforce_auth_rate_limit(request, "verify-email")
    await consume_action(db, data.token, "VERIFY", request.app.state.settings)
