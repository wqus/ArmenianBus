import asyncio
import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import create_async_engine

from armeniabus.core.config import Settings
from armeniabus.main import create_app
from armeniabus.modules.users.models import User, UserStatus


async def inspect_and_block_user(database_url: str, user_id: uuid.UUID) -> str:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            password_hash = await connection.scalar(
                select(User.password_hash).where(User.id == user_id)
            )
            await connection.execute(
                update(User).where(User.id == user_id).values(status=UserStatus.BLOCKED)
            )
            return password_hash
    finally:
        await engine.dispose()


async def delete_user(database_url: str, user_id: uuid.UUID) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.execute(delete(User).where(User.id == user_id))
    finally:
        await engine.dispose()


@pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test Redis")
def test_login_rate_limit_returns_429():
    settings = Settings(auth_rate_limit_per_minute=1)
    app = create_app(settings)
    unique_client = (f"limit-test-{uuid.uuid4().hex}", 50000)
    with TestClient(app, client=unique_client) as client:
        payload = {"email": f"missing-{uuid.uuid4().hex}@example.com", "password": "wrong"}
        first = client.post("/api/v1/auth/login", json=payload)
        second = client.post("/api/v1/auth/login", json=payload)
        assert first.status_code == 401
        assert second.status_code == 429
        assert second.json()["code"] == "RATE_LIMITED"
        assert second.headers["Retry-After"] == "60"


@pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test PostgreSQL")
def test_registration_login_rotation_revocation_and_blocking():
    settings = Settings()
    app = create_app(settings)
    email = f"test-{uuid.uuid4().hex}@example.com"
    user_id = None
    try:
        with TestClient(app) as client:
            payload = {"email": email, "password": "CorrectHorseBattery42!", "role": "PASSENGER"}
            assert client.get("/api/v1/me").status_code == 401
            assert (
                client.post("/api/v1/auth/register", json={**payload, "role": "ADMIN"}).status_code
                == 422
            )
            registration = client.post("/api/v1/auth/register", json=payload)
            assert registration.status_code == 201, registration.text
            user_id = uuid.UUID(registration.json()["id"])
            assert "password" not in registration.text

            duplicate = client.post("/api/v1/auth/register", json=payload)
            assert duplicate.status_code == 409
            assert duplicate.json()["code"] == "EMAIL_EXISTS"

            wrong_password = client.post(
                "/api/v1/auth/login", json={"email": email, "password": "incorrect"}
            )
            assert wrong_password.status_code == 401
            assert wrong_password.json()["code"] == "INVALID_CREDENTIALS"

            login = client.post(
                "/api/v1/auth/login", json={"email": email, "password": payload["password"]}
            )
            assert login.status_code == 200, login.text
            first = login.json()
            headers = {"Authorization": f"Bearer {first['access_token']}"}
            current = client.get("/api/v1/me", headers=headers)
            assert current.status_code == 200
            assert current.json()["id"] == str(user_id)
            assert (
                client.get(
                    "/api/v1/me", headers={"Authorization": "Bearer not-a-valid-token"}
                ).status_code
                == 401
            )

            rotated = client.post(
                "/api/v1/auth/refresh", json={"refresh_token": first["refresh_token"]}
            )
            assert rotated.status_code == 200, rotated.text
            second = rotated.json()
            assert second["refresh_token"] != first["refresh_token"]
            replay = client.post(
                "/api/v1/auth/refresh", json={"refresh_token": first["refresh_token"]}
            )
            assert replay.status_code == 401

            logout = client.post(
                "/api/v1/auth/logout", json={"refresh_token": second["refresh_token"]}
            )
            assert logout.status_code == 204
            revoked = client.post(
                "/api/v1/auth/refresh", json={"refresh_token": second["refresh_token"]}
            )
            assert revoked.status_code == 401

            concurrent_login = client.post(
                "/api/v1/auth/login", json={"email": email, "password": payload["password"]}
            )
            assert concurrent_login.status_code == 200
            concurrent_token = concurrent_login.json()["refresh_token"]
            with ThreadPoolExecutor(max_workers=2) as pool:
                responses = list(
                    pool.map(
                        lambda _: client.post(
                            "/api/v1/auth/refresh", json={"refresh_token": concurrent_token}
                        ),
                        range(2),
                    )
                )
            assert sorted(response.status_code for response in responses) == [200, 401]

            stored_hash = asyncio.run(inspect_and_block_user(settings.database_url, user_id))
            assert stored_hash.startswith("$argon2id$")
            assert client.get("/api/v1/me", headers=headers).status_code == 403
            assert (
                client.post(
                    "/api/v1/auth/login", json={"email": email, "password": payload["password"]}
                ).status_code
                == 403
            )
    finally:
        if user_id:
            asyncio.run(delete_user(settings.database_url, user_id))
