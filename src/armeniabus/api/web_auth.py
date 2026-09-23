"""Browser transport: HttpOnly refresh cookie, in-memory bearer access token."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.errors import ApiError, ErrorBody, error_response
from armeniabus.api.rate_limit import enforce_auth_rate_limit
from armeniabus.infrastructure.db.session import get_db_session
from armeniabus.modules.users.schemas import LoginInput, TokenPair
from armeniabus.modules.users.service import login_user, revoke_refresh_token, rotate_refresh_token


class BrowserAccess(BaseModel):
    access_token: str
    token_type: Literal["Bearer"] = "Bearer"
    expires_in: int


def cookie_name(request: Request) -> str:
    return (
        "__Host-armeniabus_refresh"
        if request.app.state.settings.app_env == "production"
        else "armeniabus_refresh"
    )


def protect_browser_request(request: Request) -> None:
    # Exact configured origin and a non-simple header are both required. No Host fallback:
    # reverse proxies can rewrite Host, and browser origins must be explicitly configured.
    if (
        request.headers.get("origin") not in request.app.state.settings.cors_origins
        or request.headers.get("x-armeniabus-web") != "1"
        or request.headers.get("sec-fetch-site") == "cross-site"
    ):
        raise ApiError(403, "CSRF_REJECTED", "Browser origin could not be verified")


router = APIRouter(
    prefix="/api/v1/auth/web",
    tags=["web-auth"],
    dependencies=[Depends(protect_browser_request)],
    responses={code: {"model": ErrorBody} for code in (401, 403, 429, 503)},
)
DbSession = Annotated[AsyncSession, Depends(get_db_session)]


def clear_cookie(request: Request, response: Response) -> None:
    response.delete_cookie(
        cookie_name(request),
        path="/",
        httponly=True,
        samesite="strict",
        secure=request.app.state.settings.app_env == "production",
    )


def browser_tokens(request: Request, response: Response, pair: TokenPair) -> BrowserAccess:
    settings = request.app.state.settings
    response.set_cookie(
        cookie_name(request),
        pair.refresh_token,
        path="/",
        httponly=True,
        secure=settings.app_env == "production",
        samesite="strict",
        max_age=settings.refresh_token_ttl_days * 86400,
    )
    return BrowserAccess(access_token=pair.access_token, expires_in=pair.expires_in)


@router.post("/login", response_model=BrowserAccess)
async def login(request: Request, response: Response, data: LoginInput, db: DbSession):
    await enforce_auth_rate_limit(request, "login", str(data.email).lower())
    pair = await login_user(db, data, request.app.state.settings)
    # Replacing a browser login also invalidates its previous refresh session.
    previous = request.cookies.get(cookie_name(request))
    if previous:
        await revoke_refresh_token(db, previous)
    return browser_tokens(request, response, pair)


@router.post("/refresh", response_model=BrowserAccess)
async def refresh(request: Request, response: Response, db: DbSession):
    token = request.cookies.get(cookie_name(request))
    if not token:
        # An anonymous page load need not consume the refresh rate limit.
        raise ApiError(401, "UNAUTHORIZED", "Authentication required")
    await enforce_auth_rate_limit(request, "refresh")
    try:
        pair = await rotate_refresh_token(db, token, request.app.state.settings)
    except ApiError as exc:
        if exc.status_code not in {401, 403}:
            raise
        result = error_response(request, exc.status_code, exc.code, exc.message)
        clear_cookie(request, result)
        return result
    return browser_tokens(request, response, pair)


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response, db: DbSession):
    token = request.cookies.get(cookie_name(request))
    if token:
        await revoke_refresh_token(db, token)
    clear_cookie(request, response)
