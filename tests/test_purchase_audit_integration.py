"""Local purchase acceptance: real API/DB/HTTP adapter/outbox/mail serialization.

Only YooKassa's HTTP boundary and the SMTP connection are simulated. No external
payment, email, private environment or production database is used.
"""

import asyncio
import json
import os
import smtplib
import uuid
from datetime import UTC, datetime, timedelta
from email import policy
from email.parser import BytesParser
from email.utils import parsedate_to_datetime

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import func, select, update

from armeniabus.core.config import Settings
from armeniabus.infrastructure.db.session import create_session_factory
from armeniabus.modules.notifications.delivery import SmtpSender, deliver_batch
from armeniabus.modules.notifications.models import Notification
from armeniabus.modules.payments.provider import YooKassa
from armeniabus.modules.payments.refunds import RefundCase
from tests.test_bookings_integration import booking_state, expire_time, held
from tests.test_bookings_integration import trip as trip
from tests.test_carriers_integration import scalar
from tests.test_carriers_integration import world as world
from tests.test_payment_provider import snapshot
from tests.test_payments_integration import checkout as checkout
from tests.test_payments_integration import details, notify, pay, succeed
from tests.test_routes_integration import journeys as journeys

pytestmark = pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test PostgreSQL")


@pytest.mark.parametrize("expired", [False, True])
def test_verified_success_reconciles_a_local_create_failure(checkout, expired):
    # The local POST failed, but a later verified object is authoritative about money.
    fake = checkout["provider"]
    fake.error_after_gate = True
    assert pay(checkout).status_code == 503
    assert details(checkout).json()["status"] == "FAILED"
    fake.error_after_gate = False
    if expired:
        expire_time(checkout["booking"])
        replacement = held(checkout, passenger=1)
    succeed(checkout)
    assert notify(checkout).status_code == 200
    assert notify(checkout).status_code == 200
    result = details(checkout).json()
    assert result["status"] == "SUCCEEDED"
    assert booking_state(checkout["booking"]) == ("EXPIRED" if expired else "PAID")
    if expired:
        assert booking_state(replacement) == "HELD"
        assert result["review_reason"] == "REFUND_REQUIRED"
        assert (
            asyncio.run(
                scalar(
                    select(func.count())
                    .select_from(RefundCase)
                    .where(RefundCase.payment_id == uuid.UUID(result["id"]))
                )
            )
            == 1
        )


@pytest.mark.parametrize("problem", ["canceled", "unpaid", "amount"])
def test_payment_review_is_visible_in_booking_cabinets(checkout, problem):
    assert pay(checkout).status_code == 200
    obj = succeed(checkout)
    assert notify(checkout).status_code == 200
    # A contradictory verified terminal state must stop an unconditional ticket.
    if problem == "canceled":
        obj.update(status="canceled", paid=False)
    elif problem == "unpaid":
        obj["paid"] = False
    else:
        obj["amount"]["value"] = "1.00"
    assert notify(checkout).status_code == 200
    reason = "PROVIDER_STATE_CONFLICT" if problem == "canceled" else "PROVIDER_DATA_MISMATCH"
    assert details(checkout).json()["review_reason"] == reason
    for path, headers in (
        (f"/api/v1/cabinet/bookings/{checkout['booking']['id']}", checkout["passengers"][0]),
        (f"/api/v1/carriers/me/bookings/{checkout['booking']['id']}", checkout["headers"]),
    ):
        response = checkout["world"].client.get(path, headers=headers)
        assert response.status_code == 200
        assert response.json()["payment_review_reason"] == reason
    obj.update(status="succeeded", paid=True)
    obj["amount"]["value"] = "4500.50"
    # A duplicate webhook cannot silently dismiss a terminal-state incident.
    assert notify(checkout).status_code == 200
    assert details(checkout).json()["review_reason"] == reason
    payment_id = details(checkout).json()["id"]
    verified = checkout["world"].client.post(
        f"/api/v1/admin/payments/{payment_id}/verify",
        headers=checkout["world"].admin,
        json={},
    )
    assert verified.status_code == 200 and verified.json()["review_reason"] is None
    assert booking_state(checkout["booking"]) == "PAID"


@pytest.mark.parametrize("smtp_outage", [False, True])
def test_purchase_webhook_confirmation_and_serialized_mail(checkout, monkeypatch, smtp_outage):
    client = checkout["world"].client
    config = client.app.state.settings
    config.smtp_host = "smtp.invalid"
    config.smtp_from = "sender@example.com"
    config.smtp_username = "test-sender"
    config.smtp_password = SecretStr("test-smtp-only")
    config.notifications_enabled = True
    external_id = str(uuid.uuid4())
    provider_object = None
    requests = []

    def transport(request):
        nonlocal provider_object
        assert request.url.host == "api.yookassa.ru"
        assert request.headers["Authorization"].startswith("Basic ")
        requests.append(request.method)
        if request.method == "POST":
            payload = json.loads(request.content)
            assert payload["amount"] == {"value": "4500.50", "currency": "RUB"}
            assert payload["capture"] is True
            assert request.headers["Idempotence-Key"] == payload["metadata"]["payment_id"]
            assert checkout["booking"]["id"] in payload["confirmation"]["return_url"]
            if provider_object is None:
                provider_object = snapshot(external_id, metadata=payload["metadata"])
        return httpx.Response(200, json=provider_object)

    adapter = YooKassa(config, httpx.MockTransport(transport))
    client.app.state.payment_provider = adapter
    messages = []
    attempts = []

    class Mailbox:
        def __init__(self, host, port, *, timeout, context):
            assert host == "smtp.invalid" and port == 465 and timeout == 10
            assert context.check_hostname and context.verify_mode.name == "CERT_REQUIRED"

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def login(self, username, password):
            assert username == "test-sender" and password == "test-smtp-only"

        def send_message(self, message):
            parsed = BytesParser(policy=policy.default).parsebytes(
                message.as_bytes(policy=policy.SMTP)
            )
            attempts.append(str(parsed["Message-ID"]))
            if smtp_outage and len(attempts) == 1:
                raise smtplib.SMTPException("private SMTP reply and recipient")
            assert parsedate_to_datetime(str(parsed["Date"])).utcoffset() == timedelta(0)
            messages.append(parsed)
            return {}

    monkeypatch.setattr("armeniabus.modules.notifications.delivery.smtplib.SMTP_SSL", Mailbox)

    async def delivery(retry=False):
        engine, sessions = create_session_factory(Settings().database_url)
        try:
            if retry:
                async with sessions() as db:
                    await db.execute(
                        update(Notification)
                        .where(Notification.booking_id == uuid.UUID(checkout["booking"]["id"]))
                        .values(next_attempt_at=datetime.now(UTC) - timedelta(seconds=1))
                    )
                    await db.commit()
            return await deliver_batch(sessions, SmtpSender(config), config)
        finally:
            await engine.dispose()

    try:
        assert pay(checkout).status_code == 200
        assert pay(checkout).status_code == 200
        # A forged success body cannot substitute for a matching provider GET.
        assert notify(checkout, external_id, status="succeeded", paid=True).status_code == 200
        assert booking_state(checkout["booking"]) == "HELD"
        assert asyncio.run(delivery()) == 0 and messages == []
        provider_object.update(status="succeeded", paid=True)
        assert notify(checkout, external_id).status_code == 200
        assert notify(checkout, external_id).status_code == 200
        assert requests.count("POST") == 1
        assert details(checkout).json()["status"] == "SUCCEEDED"
        assert details(checkout).json()["confirmation_url"] is None
        detail = client.get(
            f"/api/v1/cabinet/bookings/{checkout['booking']['id']}",
            headers=checkout["passengers"][0],
        ).json()
        assert detail["status"] == "PAID" and detail["payment_status"] == "SUCCEEDED"
        assert detail["passenger_first_name"] == "Արամ"
        assert detail["boarding_address"] == checkout["route"]["boarding_address"]
        assert (
            client.get(
                f"/api/v1/cabinet/bookings/{checkout['booking']['id']}",
                headers=checkout["passengers"][1],
            ).status_code
            == 404
        )
        if smtp_outage:
            assert asyncio.run(delivery()) == 0
            assert booking_state(checkout["booking"]) == "PAID"
            assert asyncio.run(delivery(retry=True)) == 1
            assert attempts[0] == attempts[1]
        else:
            assert asyncio.run(delivery()) == 1
        assert asyncio.run(delivery()) == 0
        assert len(messages) == 1
        body = messages[0].get_content()
        assert checkout["booking"]["id"] in body
        assert "4500.50 RUB" in body and "Место: 1" in body
        assert detail["boarding_address"] in body and detail["dropoff_address"] in body
        assert detail["departure_timezone"] in body
        assert "test-smtp-only" not in messages[0].as_string()
        # Cancellation is a separate durable action and never claims a bank refund.
        assert (
            client.delete(
                f"/api/v1/bookings/{checkout['booking']['id']}", headers=checkout["passengers"][0]
            ).status_code
            == 204
        )
        assert asyncio.run(delivery()) == 1
        assert "не подтверждает возврат денег" in messages[1].get_content()
        assert notify(checkout, external_id).status_code == 200
        assert booking_state(checkout["booking"]) == "CANCELLED"
        assert asyncio.run(delivery()) == 0
        assert len(messages) == 2
    finally:
        asyncio.run(adapter.close())
