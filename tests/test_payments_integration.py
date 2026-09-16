import asyncio
import copy
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import SecretStr
from sqlalchemy import func, select

from armeniabus.core.config import Settings
from armeniabus.infrastructure.db.session import create_session_factory
from armeniabus.modules.admin.models import AuditLog
from armeniabus.modules.payments.models import Payment
from armeniabus.modules.payments.provider import ProviderError, ProviderPayment
from armeniabus.modules.payments.service import reconcile_batch
from tests.test_bookings_integration import booking_state, expire_time, held
from tests.test_bookings_integration import trip as trip
from tests.test_carriers_integration import scalar
from tests.test_carriers_integration import world as world
from tests.test_payment_provider import snapshot
from tests.test_routes_integration import journeys as journeys
from tests.test_search_integration import change_record

pytestmark = pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test PostgreSQL")


class FakeProvider:
    def __init__(self, settings):
        self.settings = settings
        self.objects = {}
        self.keys = {}
        self.requests = []
        self.fail_after_create = False
        self.fail_get = False
        self.gate = None
        self.error_after_gate = False

    async def create(self, key, payload):
        self.requests.append((str(key), copy.deepcopy(payload)))
        if str(key) not in self.keys:
            data = snapshot(metadata=payload["metadata"], amount=payload["amount"])
            self.keys[str(key)] = data["id"]
            self.objects[data["id"]] = data
        if self.gate:
            self.gate.set()
            while self.fail_after_create:
                await asyncio.sleep(0.01)
        if self.error_after_gate:
            raise ProviderError("PROVIDER_REJECTED")
        if self.fail_after_create:
            self.fail_after_create = False
            raise ProviderError("PROVIDER_UNAVAILABLE")
        return ProviderPayment.model_validate(self.objects[self.keys[str(key)]])

    async def get(self, external_id):
        if self.fail_get:
            raise ProviderError("PROVIDER_UNAVAILABLE")
        if external_id not in self.objects:
            raise ProviderError("PROVIDER_NOT_FOUND")
        return ProviderPayment.model_validate(self.objects[external_id])

    async def close(self):
        pass


@pytest.fixture
def checkout(trip):
    client = trip["world"].client
    config = client.app.state.settings
    config.payments_enabled = True
    config.yookassa_shop_id = "123"
    config.yookassa_secret_key = SecretStr("test-key")
    original = client.app.state.payment_provider
    fake = FakeProvider(config)
    client.app.state.payment_provider = fake
    trip.update(booking=held(trip), key=str(uuid.uuid4()), provider=fake)
    try:
        yield trip
    finally:
        client.app.state.payment_provider = original


def pay(context, key=None, passenger=0, booking=None, **kwargs):
    return context["world"].client.post(
        f"/api/v1/bookings/{(booking or context['booking'])['id']}/pay",
        headers={**context["passengers"][passenger], "Idempotency-Key": key or context["key"]},
        **kwargs,
    )


def notify(context, external_id=None, **extra):
    external_id = external_id or next(iter(context["provider"].objects))
    return context["world"].client.post(
        "/api/v1/webhooks/payments",
        json={
            "type": "notification",
            "event": "payment.succeeded",
            "object": {"id": external_id, **extra},
        },
    )


def succeed(context):
    obj = next(iter(context["provider"].objects.values()))
    obj.update(status="succeeded", paid=True)
    return obj


def details(context, passenger=0):
    return context["world"].client.get(
        f"/api/v1/bookings/{context['booking']['id']}/payment",
        headers=context["passengers"][passenger],
    )


def test_idempotent_payment_and_verified_duplicate_webhook(checkout):
    first = pay(checkout)
    assert first.status_code == 200, first.text
    assert first.json()["amount"] == "4500.50" and first.json()["status"] == "PENDING"
    assert first.json()["confirmation_url"].startswith("https://")
    assert pay(checkout).json()["id"] == first.json()["id"]
    assert len(checkout["provider"].objects) == 1
    assert pay(checkout, key=str(uuid.uuid4())).status_code == 409
    # Forging the notification body cannot change the actual provider state.
    assert notify(checkout, status="succeeded", paid=True).status_code == 200
    assert booking_state(checkout["booking"]) == "HELD"
    succeed(checkout)
    for _ in range(2):
        assert notify(checkout).status_code == 200
    assert booking_state(checkout["booking"]) == "PAID"
    assert details(checkout).json()["status"] == "SUCCEEDED"
    assert details(checkout).json()["confirmation_url"] is None
    assert pay(checkout).json()["status"] == "SUCCEEDED"
    count = asyncio.run(
        scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(
                AuditLog.action == "booking.paid",
                AuditLog.entity_id == uuid.UUID(checkout["booking"]["id"]),
            )
        )
    )
    assert count == 1


def test_timeout_retries_same_durable_key_and_exact_payload(checkout):
    fake = checkout["provider"]
    fake.fail_after_create = True
    assert pay(checkout).status_code == 503
    pending = details(checkout).json()
    assert pending["status"] == "PENDING"
    checkout[
        "world"
    ].client.app.state.settings.payment_return_url = "https://changed.example/result"
    retry = pay(checkout)
    assert retry.status_code == 200
    assert retry.json()["id"] == pending["id"]
    assert fake.requests[0] == fake.requests[1]
    assert len(fake.objects) == 1


def test_webhook_recovers_external_id_before_create_response(checkout):
    fake = checkout["provider"]
    fake.fail_after_create = True
    assert pay(checkout).status_code == 503
    succeed(checkout)
    assert notify(checkout, metadata={"booking_id": str(uuid.uuid4())}).status_code == 200
    assert booking_state(checkout["booking"]) == "PAID"
    assert details(checkout).json()["status"] == "SUCCEEDED"


@pytest.mark.parametrize("field", ["amount", "currency", "shop", "test", "metadata"])
def test_provider_mismatch_never_marks_booking_paid(checkout, field):
    assert pay(checkout).status_code == 200
    obj = succeed(checkout)
    if field == "amount":
        obj["amount"]["value"] = "1.00"
    elif field == "currency":
        obj["amount"]["currency"] = "USD"
    elif field == "shop":
        obj["recipient"]["account_id"] = "999"
    elif field == "test":
        obj["test"] = False
    else:
        obj["metadata"]["booking_id"] = str(uuid.uuid4())
    assert notify(checkout).status_code == 200
    assert booking_state(checkout["booking"]) == "HELD"
    assert details(checkout).json()["review_reason"] == "PROVIDER_DATA_MISMATCH"


@pytest.mark.parametrize("terminal", ["expired", "cancelled"])
def test_late_success_does_not_resurrect_or_take_another_passengers_seat(checkout, terminal):
    assert pay(checkout).status_code == 200
    if terminal == "expired":
        expire_time(checkout["booking"])
    else:
        client = checkout["world"].client
        assert (
            client.delete(
                f"/api/v1/bookings/{checkout['booking']['id']}", headers=checkout["passengers"][0]
            ).status_code
            == 204
        )
    new_booking = held(checkout, passenger=1)
    succeed(checkout)
    assert notify(checkout).status_code == 200
    assert booking_state(checkout["booking"]) == terminal.upper()
    assert booking_state(new_booking) == "HELD"
    payment = details(checkout).json()
    assert payment["status"] == "SUCCEEDED" and payment["review_reason"] == "REFUND_REQUIRED"


def test_cancellation_and_provider_outage(checkout):
    assert pay(checkout).status_code == 200
    fake = checkout["provider"]
    fake.fail_get = True
    assert notify(checkout).status_code == 503
    assert booking_state(checkout["booking"]) == "HELD"
    fake.fail_get = False
    obj = next(iter(fake.objects.values()))
    obj["status"] = "canceled"
    assert notify(checkout).status_code == 200
    assert details(checkout).json()["status"] == "CANCELED"
    assert booking_state(checkout["booking"]) == "CANCELLED"


async def reconcile(context):
    engine, sessions = create_session_factory(Settings().database_url)
    try:
        return await reconcile_batch(sessions, context["provider"], context["provider"].settings)
    finally:
        await engine.dispose()


def test_worker_recovers_missing_webhook_and_does_not_create_after_expiry(checkout):
    payment = pay(checkout).json()
    succeed(checkout)
    asyncio.run(
        change_record(
            Payment, payment["id"], next_check_at=datetime.now(UTC) - timedelta(seconds=1)
        )
    )
    assert asyncio.run(reconcile(checkout)) == 1
    assert booking_state(checkout["booking"]) == "PAID"
    assert asyncio.run(reconcile(checkout)) == 0


def test_unknown_timeout_result_stops_post_retries_after_hold_expiry(checkout):
    fake = checkout["provider"]
    fake.fail_after_create = True
    assert pay(checkout).status_code == 503
    payment = details(checkout).json()
    expire_time(checkout["booking"])
    asyncio.run(
        change_record(
            Payment, payment["id"], next_check_at=datetime.now(UTC) - timedelta(seconds=1)
        )
    )
    assert asyncio.run(reconcile(checkout)) == 1
    assert len(fake.requests) == 1
    assert details(checkout).json()["review_reason"] == "UNKNOWN_RESULT_REQUIRES_REVIEW"
    succeed(checkout)
    assert notify(checkout).status_code == 200
    assert details(checkout).json()["review_reason"] == "REFUND_REQUIRED"


def test_payment_ownership_validation_and_disabled_configuration(checkout):
    assert pay(checkout, passenger=1).status_code == 404
    assert details(checkout, passenger=1).status_code == 404
    assert (
        pay(checkout, json={"amount": "1", "return_url": "https://evil.example"}).status_code == 422
    )
    client = checkout["world"].client
    path = f"/api/v1/bookings/{checkout['booking']['id']}/pay"
    assert client.post(path, headers=checkout["passengers"][0]).status_code == 422
    client.app.state.settings.payments_enabled = False
    assert pay(checkout).status_code == 503
    client.app.state.settings.payments_enabled = True
    expire_time(checkout["booking"])
    assert pay(checkout).status_code == 410
    assert not checkout["provider"].requests


def test_concurrent_payment_requests_reuse_single_intent(checkout):
    gate = threading.Barrier(8)

    def attempt(_):
        gate.wait(timeout=15)
        return pay(checkout)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(attempt, range(8)))
    assert all(r.status_code == 200 for r in results), [r.text for r in results]
    assert len({r.json()["id"] for r in results}) == 1
    assert len(checkout["provider"].objects) == 1


def test_concurrent_webhooks_confirm_booking_once(checkout):
    assert pay(checkout).status_code == 200
    succeed(checkout)
    gate = threading.Barrier(8)

    def attempt(_):
        gate.wait(timeout=15)
        return notify(checkout)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(attempt, range(8)))
    assert all(r.status_code == 200 for r in results)
    assert booking_state(checkout["booking"]) == "PAID"
    count = asyncio.run(
        scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(
                AuditLog.action == "booking.paid",
                AuditLog.entity_id == uuid.UUID(checkout["booking"]["id"]),
            )
        )
    )
    assert count == 1


def test_carrier_block_during_http_is_rechecked_after_locks(checkout):
    fake = checkout["provider"]
    fake.gate = threading.Event()
    fake.fail_after_create = True
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(pay, checkout)
        try:
            assert fake.gate.wait(timeout=10)
            assert checkout["world"].status(checkout["profile"]["id"], "BLOCKED").status_code == 200
            succeed(checkout)
        finally:
            fake.fail_after_create = False
        response = future.result(timeout=15)
    assert response.status_code == 200, response.text
    assert response.json()["review_reason"] == "REFUND_REQUIRED"
    assert booking_state(checkout["booking"]) == "HELD"


def test_late_http_error_cannot_overwrite_verified_success(checkout):
    fake = checkout["provider"]
    fake.gate = threading.Event()
    fake.fail_after_create = True
    fake.error_after_gate = True
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(pay, checkout)
        try:
            assert fake.gate.wait(timeout=10)
            succeed(checkout)
            assert notify(checkout).status_code == 200
        finally:
            fake.fail_after_create = False
        response = future.result(timeout=15)
    assert response.status_code == 503
    assert details(checkout).json()["status"] == "SUCCEEDED"
    assert booking_state(checkout["booking"]) == "PAID"


def test_client_key_cannot_be_reused_for_another_booking(checkout):
    assert pay(checkout).status_code == 200
    other = held(checkout, seat=1)
    assert pay(checkout, booking=other).status_code == 409
    assert len(checkout["provider"].objects) == 1
