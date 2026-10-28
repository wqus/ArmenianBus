import asyncio
import os
import re
import smtplib
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from sqlalchemy import func, select

from armeniabus.core.security import verify_password
from armeniabus.infrastructure.db.session import create_session_factory
from armeniabus.modules.admin.models import AuditLog
from armeniabus.modules.users.actions import action_token
from armeniabus.modules.users.mail import deliver_account_batch
from armeniabus.modules.users.models import AuthAction, User
from tests.test_carriers_integration import PASSWORD, scalar
from tests.test_carriers_integration import world as world
from tests.test_search_integration import change_record

pytestmark = pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test PostgreSQL")
NEW_PASSWORD = "New-Recovered-Password-42!"


def enable_mail(context):
    settings = context.client.app.state.settings
    settings.smtp_host = "smtp.invalid"
    settings.smtp_from = "noreply@example.com"
    settings.notifications_enabled = True
    return settings


def latest(context, email, purpose="RESET"):
    return asyncio.run(
        scalar(
            select(AuthAction.id)
            .join(User)
            .where(User.email == email, AuthAction.purpose == purpose)
            .order_by(AuthAction.created_at.desc())
        )
    )


def link(context, email, purpose="RESET"):
    return action_token(latest(context, email, purpose), purpose, context.client.app.state.settings)


def forgot(context, email):
    response = context.client.post("/api/v1/auth/forgot-password", json={"email": email})
    assert response.status_code == 202, response.text
    return response


def reset(context, token, password=NEW_PASSWORD):
    return context.client.post(
        "/api/v1/auth/reset-password", json={"token": token, "password": password}
    )


def test_reset_is_private_single_use_revokes_access_and_refresh_and_does_not_login(world):
    email, headers = world.account("PASSENGER")
    old_pair = world.client.post(
        "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
    ).json()
    claims = jwt.decode(old_pair["access_token"], options={"verify_signature": False})
    claims.pop("ver")
    legacy = jwt.encode(
        claims, world.client.app.state.settings.jwt_secret_key.get_secret_value(), algorithm="HS256"
    )
    legacy_headers = {"Authorization": "Bearer " + legacy}
    assert world.client.get("/api/v1/me", headers=legacy_headers).status_code == 200
    enable_mail(world)
    existing = forgot(world, email.upper())
    missing = forgot(world, "missing@example.com")
    assert existing.json() == missing.json()
    assert "token" not in existing.text
    token = link(world, email)
    action_id = latest(world, email)
    digest = asyncio.run(scalar(select(AuthAction.token_hash).where(AuthAction.id == action_id)))
    assert token not in digest and len(digest) == 64
    assert world.client.get("/api/v1/me", headers=headers).status_code == 200
    # A previously delivered link remains usable during a mail outage; the security
    # notice must still be queued durably for the worker to deliver after recovery.
    world.client.app.state.settings.notifications_enabled = False
    response = reset(world, token)
    assert response.status_code == 204 and "set-cookie" not in response.headers
    assert world.client.get("/api/v1/me", headers=headers).status_code == 401
    assert world.client.get("/api/v1/me", headers=legacy_headers).status_code == 401
    assert (
        world.client.post(
            "/api/v1/auth/refresh", json={"refresh_token": old_pair["refresh_token"]}
        ).status_code
        == 401
    )
    assert (
        world.client.post(
            "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
        ).status_code
        == 401
    )
    login = world.client.post("/api/v1/auth/login", json={"email": email, "password": NEW_PASSWORD})
    assert login.status_code == 200
    assert (
        world.client.get(
            "/api/v1/me", headers={"Authorization": "Bearer " + login.json()["access_token"]}
        ).status_code
        == 200
    )
    assert reset(world, token).json()["code"] == "ACTION_LINK_INVALID"
    user_id = asyncio.run(scalar(select(User.id).where(User.email == email)))
    event = asyncio.run(
        scalar(
            select(AuditLog.event_data).where(
                AuditLog.entity_id == user_id, AuditLog.action == "user.password_reset"
            )
        )
    )
    assert event == {}
    assert (
        asyncio.run(
            scalar(
                select(func.count())
                .select_from(AuthAction)
                .where(AuthAction.user_id == user_id, AuthAction.purpose == "PASSWORD_CHANGED")
            )
        )
        == 1
    )


def test_verification_needs_explicit_post_and_does_not_allow_cross_purpose_or_reuse(world):
    settings = enable_mail(world)
    email, headers = world.account("PASSENGER")
    token = link(world, email, "VERIFY")
    assert world.client.get("/api/v1/me", headers=headers).json()["email_verified_at"] is None
    assert reset(world, token).status_code == 400
    assert world.client.get("/api/v1/auth/verify-email", params={"token": token}).status_code == 405
    assert world.client.get("/api/v1/me", headers=headers).json()["email_verified_at"] is None
    assert world.client.post("/api/v1/auth/verify-email", json={"token": token}).status_code == 204
    assert world.client.get("/api/v1/me", headers=headers).json()["email_verified_at"] is not None
    assert world.client.post("/api/v1/auth/verify-email", json={"token": token}).status_code == 400
    assert (
        world.client.post("/api/v1/auth/verification/request", headers=headers).status_code == 202
    )
    assert latest(world, email, "VERIFY") is not None
    assert settings.notifications_enabled


def test_expired_tampered_blocked_and_rotated_key_links_fail_without_password_change(world):
    email, headers = world.account("PASSENGER")
    settings = enable_mail(world)
    forgot(world, email)
    token = link(world, email)
    assert reset(world, token[:-1] + ("0" if token[-1] != "0" else "1")).status_code == 400
    action_id = latest(world, email)
    asyncio.run(
        change_record(
            AuthAction, str(action_id), expires_at=datetime.now(UTC) - timedelta(seconds=1)
        )
    )
    assert reset(world, token).status_code == 400
    asyncio.run(
        change_record(
            AuthAction, str(action_id), expires_at=datetime.now(UTC) + timedelta(minutes=10)
        )
    )
    user_id = asyncio.run(scalar(select(User.id).where(User.email == email)))
    asyncio.run(change_record(User, str(user_id), status="BLOCKED"))
    assert reset(world, token).status_code == 400
    asyncio.run(change_record(User, str(user_id), status="ACTIVE"))
    from pydantic import SecretStr

    settings.jwt_secret_key = SecretStr("rotated-test-secret-with-at-least-32-characters")
    assert reset(world, token).status_code == 400
    assert (
        world.client.post(
            "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
        ).status_code
        == 200
    )


def test_disabled_mail_does_not_pretend_to_send_and_request_cooldown_does_not_invalidate(world):
    email, _ = world.account("PASSENGER")
    assert (
        world.client.post("/api/v1/auth/forgot-password", json={"email": email}).status_code == 503
    )
    enable_mail(world)
    forgot(world, email)
    first = link(world, email)
    first_id = latest(world, email)
    forgot(world, email)
    assert latest(world, email) == first_id
    for index in range(5):
        asyncio.run(
            change_record(
                AuthAction,
                str(latest(world, email)),
                created_at=datetime.now(UTC) - timedelta(minutes=2 + index),
            )
        )
        forgot(world, email)
    count = asyncio.run(
        scalar(select(func.count()).select_from(AuthAction).where(AuthAction.purpose == "RESET"))
    )
    assert count == 5
    assert reset(world, first).status_code == 204


def test_two_consumers_have_one_winner_and_late_old_password_login_is_rejected(world, monkeypatch):
    email, _ = world.account("PASSENGER")
    enable_mail(world)
    forgot(world, email)
    token = link(world, email)
    entered, release = threading.Event(), threading.Event()

    def delayed(password, stored):
        result = verify_password(password, stored)
        entered.set()
        assert release.wait(10)
        return result

    monkeypatch.setattr("armeniabus.modules.users.service.verify_password", delayed)
    with ThreadPoolExecutor(max_workers=3) as pool:
        login = pool.submit(
            world.client.post, "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
        )
        try:
            assert entered.wait(10)
            results = list(pool.map(lambda _: reset(world, token).status_code, range(2)))
            assert sorted(results) == [204, 400]
        finally:
            release.set()
        assert login.result().status_code == 401


class FakeSender:
    def __init__(self, fail=False):
        self.messages = []
        self.fail = fail

    async def send(self, message):
        if self.fail:
            raise smtplib.SMTPException("private recipient and token must not be persisted")
        self.messages.append(message)


def deliver(context, sender):
    async def run():
        settings = context.client.app.state.settings
        engine, sessions = create_session_factory(settings.database_url)
        try:
            return await deliver_account_batch(sessions, sender, settings)
        finally:
            await engine.dispose()

    return asyncio.run(run())


def test_account_mail_uses_trusted_fragment_links_and_retries_without_storing_bearers(world):
    email, _ = world.account("PASSENGER")
    settings = enable_mail(world)
    from pydantic import HttpUrl

    settings.auth_public_origin = HttpUrl("https://bus.example.com")
    forgot(world, email)
    action_id = latest(world, email)
    assert deliver(world, FakeSender(fail=True)) == 0
    error = asyncio.run(scalar(select(AuthAction.last_error).where(AuthAction.id == action_id)))
    assert error == "SMTPException"
    asyncio.run(change_record(AuthAction, str(action_id), next_attempt_at=datetime.now(UTC)))
    sender = FakeSender()
    assert deliver(world, sender) == 1
    message = sender.messages[0]
    assert message.recipient_email == email
    assert "https://bus.example.com/reset-password#token=" in message.body
    token = re.search(r"#token=(\S+)", message.body)[1]
    assert reset(world, token).status_code == 204
    done_sender = FakeSender()
    assert deliver(world, done_sender) == 1
    assert "пароль изменён" in done_sender.messages[0].subject
    assert (
        NEW_PASSWORD not in done_sender.messages[0].body
        and "#token=" not in done_sender.messages[0].body
    )


def test_account_mail_claims_are_exclusive_and_expired_links_are_never_sent(world):
    email, _ = world.account("PASSENGER")
    settings = enable_mail(world)
    forgot(world, email)
    sender = FakeSender()

    async def run():
        engine, sessions = create_session_factory(settings.database_url)
        try:
            return await asyncio.gather(
                deliver_account_batch(sessions, sender, settings),
                deliver_account_batch(sessions, sender, settings),
            )
        finally:
            await engine.dispose()

    assert sum(asyncio.run(run())) == 1
    assert len(sender.messages) == 1
    action_id = latest(world, email)
    asyncio.run(
        change_record(
            AuthAction, str(action_id), created_at=datetime.now(UTC) - timedelta(minutes=2)
        )
    )
    forgot(world, email)
    expired = latest(world, email)
    asyncio.run(
        change_record(AuthAction, str(expired), expires_at=datetime.now(UTC) - timedelta(seconds=1))
    )
    assert deliver(world, sender) == 0
    assert len(sender.messages) == 1
    assert (
        asyncio.run(scalar(select(AuthAction.mail_status).where(AuthAction.id == expired)))
        == "FAILED"
    )


def test_browser_reset_clears_cookie_and_preserves_csrf_rules(world):
    email, _ = world.account("PASSENGER")
    origin = "http://localhost:5173"
    world.client.app.state.settings.cors_origins = [origin]
    headers = {"Origin": origin, "X-ArmeniaBus-Web": "1"}
    assert (
        world.client.post(
            "/api/v1/auth/web/login", headers=headers, json={"email": email, "password": PASSWORD}
        ).status_code
        == 200
    )
    enable_mail(world)
    forgot(world, email)
    token = link(world, email)
    body = {"token": token, "password": NEW_PASSWORD}
    assert world.client.post("/api/v1/auth/web/reset-password", json=body).status_code == 403
    response = world.client.post("/api/v1/auth/web/reset-password", headers=headers, json=body)
    assert response.status_code == 204 and "Max-Age=0" in response.headers["set-cookie"]
