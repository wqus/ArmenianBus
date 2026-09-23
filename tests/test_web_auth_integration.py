import asyncio
import os

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import create_async_engine

from armeniabus.core.config import Settings
from armeniabus.core.security import refresh_token_hash
from armeniabus.modules.users.models import RefreshSession, User
from tests.test_carriers_integration import PASSWORD, scalar, world  # noqa: F401

pytestmark = pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test PostgreSQL")
ORIGIN = "http://localhost:5173"
HEADERS = {"Origin": ORIGIN, "X-ArmeniaBus-Web": "1"}
PREFIX = "/api/v1/auth/web"


def prepare(context):
    context.client.app.state.settings.cors_origins = [ORIGIN]
    email, _ = context.account("PASSENGER")
    return {"email": email, "password": PASSWORD}


def test_cookie_login_rotation_logout_and_replay(world):  # noqa: F811
    data = prepare(world)
    client = world.client
    response = client.post(PREFIX + "/login", headers=HEADERS, json=data)
    assert response.status_code == 200, response.text
    assert "refresh_token" not in response.json()
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie and "path=/" in cookie
    assert "domain=" not in cookie
    old = client.cookies.get("armeniabus_refresh")
    assert old and old not in response.text
    assert client.get("/api/v1/me").status_code == 401  # Cookie alone is not API authorization.
    headers = {"Authorization": "Bearer " + response.json()["access_token"]}
    assert client.get("/api/v1/me", headers=headers).json()["email"] == data["email"]
    rotated = client.post(PREFIX + "/refresh", headers=HEADERS)
    assert rotated.status_code == 200
    replacement = client.cookies.get("armeniabus_refresh")
    assert replacement != old
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": old}).status_code == 401
    assert client.post(PREFIX + "/logout", headers=HEADERS).status_code == 204
    assert client.cookies.get("armeniabus_refresh") is None
    assert (
        client.post("/api/v1/auth/refresh", json={"refresh_token": replacement}).status_code == 401
    )
    assert client.post(PREFIX + "/logout", headers=HEADERS).status_code == 204
    assert client.post(PREFIX + "/refresh", headers=HEADERS).status_code == 401


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Origin": ORIGIN},
        {"X-ArmeniaBus-Web": "1"},
        {"Origin": "https://attacker.example", "X-ArmeniaBus-Web": "1"},
        {"Origin": "null", "X-ArmeniaBus-Web": "1"},
        {**HEADERS, "Sec-Fetch-Site": "cross-site"},
    ],
)
def test_csrf_rejection_leaves_session_untouched(world, headers):  # noqa: F811
    data = prepare(world)
    client = world.client
    assert client.post(PREFIX + "/login", headers=HEADERS, json=data).status_code == 200
    token = client.cookies.get("armeniabus_refresh")
    for path in ("/login", "/refresh", "/logout"):
        response = client.post(PREFIX + path, headers=headers, json=data)
        assert response.status_code == 403
        assert response.json()["code"] == "CSRF_REJECTED"
        assert "set-cookie" not in response.headers
    assert client.cookies.get("armeniabus_refresh") == token
    assert client.post(PREFIX + "/refresh", headers=HEADERS).status_code == 200


def test_blocked_refresh_clears_cookie_and_login_replaces_previous_session(world):  # noqa: F811
    data = prepare(world)
    client = world.client
    assert client.post(PREFIX + "/login", headers=HEADERS, json=data).status_code == 200
    previous = client.cookies.get("armeniabus_refresh")
    assert client.post(PREFIX + "/login", headers=HEADERS, json=data).status_code == 200
    revoked = asyncio.run(
        scalar(
            select(RefreshSession.revoked_at).where(
                RefreshSession.token_hash == refresh_token_hash(previous)
            )
        )
    )
    assert revoked is not None

    async def block():
        engine = create_async_engine(Settings().database_url)
        try:
            async with engine.begin() as db:
                await db.execute(
                    update(User).where(User.email == data["email"]).values(status="BLOCKED")
                )
        finally:
            await engine.dispose()

    asyncio.run(block())
    response = client.post(PREFIX + "/refresh", headers=HEADERS)
    assert response.status_code == 403
    assert response.json()["code"] == "USER_BLOCKED"
    assert client.cookies.get("armeniabus_refresh") is None


def test_secure_host_cookie_in_production(world):  # noqa: F811
    data = prepare(world)
    world.client.app.state.settings.app_env = "production"
    response = world.client.post(PREFIX + "/login", headers=HEADERS, json=data)
    assert response.status_code == 200
    cookie = response.headers["set-cookie"]
    assert cookie.startswith("__Host-armeniabus_refresh=")
    assert "Secure" in cookie and "HttpOnly" in cookie and "Path=/" in cookie
    assert "Domain=" not in cookie
