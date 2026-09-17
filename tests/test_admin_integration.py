import asyncio
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from armeniabus.modules.admin.models import AuditLog
from armeniabus.modules.notifications.models import Notification
from armeniabus.modules.payments.models import Payment
from armeniabus.modules.payments.refunds import RefundCase
from armeniabus.modules.users.models import RefreshSession
from tests.test_bookings_integration import booking_state, expire_time, held
from tests.test_bookings_integration import trip as trip
from tests.test_cabinets_integration import cabinet, complete_payment
from tests.test_carriers_integration import PASSWORD, scalar
from tests.test_carriers_integration import world as world
from tests.test_payments_integration import checkout as checkout
from tests.test_payments_integration import notify, pay, succeed
from tests.test_routes_integration import journeys as journeys
from tests.test_search_integration import change_record

pytestmark = pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test PostgreSQL")


def audit_count(entity_id, action):
    return asyncio.run(
        scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.entity_id == uuid.UUID(str(entity_id)), AuditLog.action == action)
        )
    )


def get_case(context):
    response = context["world"].client.get(
        "/api/v1/admin/refund-cases", headers=context["world"].admin
    )
    assert response.status_code == 200, response.text
    return response.json()["items"][0]


def cancel_paid(context):
    response = context["world"].client.delete(
        f"/api/v1/bookings/{context['booking']['id']}", headers=context["passengers"][0]
    )
    assert response.status_code == 204, response.text


def test_admin_inspection_filters_details_and_rbac(checkout):
    payment = complete_payment(checkout)
    world, booking = checkout["world"], checkout["booking"]
    passenger_id = world.client.get("/api/v1/me", headers=checkout["passengers"][0]).json()["id"]
    paths = [
        "users",
        "routes",
        "bookings",
        "payments",
        "audit",
        "notifications",
        "refund-cases",
        f"users/{passenger_id}",
        f"routes/{checkout['route']['id']}",
        f"bookings/{booking['id']}",
        f"payments/{payment['id']}",
        f"carriers/{checkout['profile']['id']}",
    ]
    for path in paths:
        url = f"/api/v1/admin/{path}"
        assert world.client.get(url).status_code == 401
        for headers in (checkout["headers"], checkout["passengers"][0]):
            assert world.client.get(url, headers=headers).status_code == 403
        response = world.client.get(url, headers=world.admin)
        assert response.status_code == 200, response.text
        for secret in (
            "password_hash",
            "token_hash",
            "request_payload",
            "confirmation_url",
            "client_key",
        ):
            assert secret not in response.text
    response = world.client.get(
        "/api/v1/admin/payments",
        headers=world.admin,
        params={"status": "SUCCEEDED", "booking_id": booking["id"], "review_required": False},
    ).json()
    assert [p["id"] for p in response["items"]] == [payment["id"]]
    assert (
        world.client.get(
            "/api/v1/admin/payments", headers=world.admin, params={"status": "PENDING"}
        ).json()["items"]
        == []
    )
    for resource in ("users", "routes", "bookings", "payments", "notifications", "refund-cases"):
        assert (
            world.client.get(
                f"/api/v1/admin/{resource}/{uuid.uuid4()}", headers=world.admin
            ).status_code
            == 404
        )
        assert (
            world.client.get(f"/api/v1/admin/{resource}?limit=101", headers=world.admin).status_code
            == 422
        )
        assert (
            world.client.get(
                f"/api/v1/admin/{resource}?offset=10001", headers=world.admin
            ).status_code
            == 422
        )
    records = world.client.get(
        "/api/v1/admin/audit",
        headers=world.admin,
        params={"entity_id": booking["id"], "action": "booking.paid"},
    ).json()["items"]
    assert len(records) == 1 and records[0]["actor_user_id"] is None
    first = world.client.get("/api/v1/admin/users?limit=1", headers=world.admin).json()["items"]
    second = world.client.get("/api/v1/admin/users?limit=1&offset=1", headers=world.admin).json()[
        "items"
    ]
    assert len(first) == len(second) == 1 and first[0]["id"] != second[0]["id"]


def test_block_unblock_revokes_refresh_and_protects_admin_accounts(world):
    email, headers = world.account("PASSENGER")
    client = world.client
    user_id = client.get("/api/v1/me", headers=headers).json()["id"]
    tokens = client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD}).json()
    path = f"/api/v1/admin/users/{user_id}/status"
    body = {"status": "BLOCKED", "reason": "Reported account misuse"}
    assert client.patch(path, headers=headers, json=body).status_code == 403
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(lambda _: client.patch(path, headers=world.admin, json=body), range(2))
        )
    assert [r.status_code for r in responses] == [200, 200]
    assert audit_count(user_id, "user.status_changed") == 1
    assert client.get("/api/v1/me", headers=headers).status_code == 403
    assert (
        client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD}).status_code
        == 403
    )
    assert (
        client.patch(
            path, headers=world.admin, json={"status": "ACTIVE", "reason": "Reviewed"}
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
        ).status_code
        == 401
    )
    assert (
        client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD}).status_code
        == 200
    )
    admin_id = client.get("/api/v1/me", headers=world.admin).json()["id"]
    assert (
        client.patch(
            f"/api/v1/admin/users/{admin_id}/status", headers=world.admin, json=body
        ).status_code
        == 409
    )
    assert (
        client.patch(
            path, headers=world.admin, json={"status": "BLOCKED", "reason": " "}
        ).status_code
        == 422
    )
    assert (
        client.patch(path, headers=world.admin, json={**body, "role": "ADMIN"}).status_code == 422
    )


def test_carrier_account_block_during_payment_and_admin_route_cancellation(checkout):
    world, fake = checkout["world"], checkout["provider"]
    fake.gate, fake.fail_after_create = threading.Event(), True
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(pay, checkout)
        try:
            assert fake.gate.wait(10)
            user_id = checkout["profile"]["user_id"]
            response = world.client.patch(
                f"/api/v1/admin/users/{user_id}/status",
                headers=world.admin,
                json={"status": "BLOCKED", "reason": "Operational review"},
            )
            assert response.status_code == 200
            succeed(checkout)
        finally:
            fake.fail_after_create = False
        assert pending.result(timeout=15).status_code == 200
    assert booking_state(checkout["booking"]) == "HELD"
    assert get_case(checkout)["status"] == "OPEN"
    assert world.client.get(f"/api/v1/routes/{checkout['route']['id']}").status_code == 404
    assert world.client.get("/api/v1/carriers/me", headers=checkout["headers"]).status_code == 403
    path = f"/api/v1/admin/routes/{checkout['route']['id']}/cancel"
    for _ in range(2):
        assert (
            world.client.post(
                path, headers=world.admin, json={"reason": "Carrier unavailable"}
            ).status_code
            == 200
        )
    assert booking_state(checkout["booking"]) == "CANCELLED"
    assert audit_count(checkout["route"]["id"], "route.admin_cancelled") == 1


@pytest.mark.parametrize("operation", ["login", "refresh"])
def test_block_racing_token_issuance_leaves_no_active_refresh(world, operation):
    email, headers = world.account("PASSENGER")
    client = world.client
    user_id = client.get("/api/v1/me", headers=headers).json()["id"]
    tokens = client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD}).json()
    barrier = threading.Barrier(2)

    def issue():
        barrier.wait(timeout=10)
        body = (
            {"email": email, "password": PASSWORD}
            if operation == "login"
            else {"refresh_token": tokens["refresh_token"]}
        )
        return client.post(f"/api/v1/auth/{operation}", json=body)

    def block():
        barrier.wait(timeout=10)
        return client.patch(
            f"/api/v1/admin/users/{user_id}/status",
            headers=world.admin,
            json={"status": "BLOCKED", "reason": "Concurrent account block"},
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        issued, blocked = pool.submit(issue), pool.submit(block)
        token_response = issued.result(timeout=15)
        assert blocked.result(timeout=15).status_code == 200
    assert token_response.status_code in (200, 401, 403)
    assert (
        asyncio.run(
            scalar(
                select(func.count())
                .select_from(RefreshSession)
                .where(
                    RefreshSession.user_id == uuid.UUID(user_id),
                    RefreshSession.revoked_at.is_(None),
                )
            )
        )
        == 0
    )
    assert (
        client.patch(
            f"/api/v1/admin/users/{user_id}/status",
            headers=world.admin,
            json={"status": "ACTIVE", "reason": "Unblock after review"},
        ).status_code
        == 200
    )
    if token_response.status_code == 200:
        assert (
            client.post(
                "/api/v1/auth/refresh",
                json={"refresh_token": token_response.json()["refresh_token"]},
            ).status_code
            == 401
        )


def test_record_refund_once_without_changing_payment_fact(checkout):
    payment = complete_payment(checkout)
    cancel_paid(checkout)
    case, world = get_case(checkout), checkout["world"]
    path = f"/api/v1/admin/refund-cases/{case['id']}/record"
    body = {"reference": "manual-refund-" + uuid.uuid4().hex}
    assert world.client.post(path, headers=checkout["passengers"][0], json=body).status_code == 403
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(lambda _: world.client.post(path, headers=world.admin, json=body), range(2))
        )
    assert [r.status_code for r in responses] == [200, 200]
    assert responses[0].json()["status"] == "REFUND_RECORDED"
    assert responses[0].json()["resolved_at"] and responses[0].json()["resolved_by_user_id"]
    assert audit_count(case["id"], "refund.recorded") == 1
    assert (
        world.client.post(path, headers=world.admin, json={"reference": "different"}).status_code
        == 409
    )
    item = cabinet(checkout).json()["items"][0]
    assert not item["refund_required"] and item["refund_status"] == "REFUND_RECORDED"
    assert item["payment_status"] == "SUCCEEDED" and item["status"] == "CANCELLED"
    assert notify(checkout).status_code == 200
    assert get_case(checkout)["status"] == "REFUND_RECORDED"
    detail = world.client.get(f"/api/v1/admin/payments/{payment['id']}", headers=world.admin).json()
    assert detail["review_reason"] is None
    assert (
        world.client.get("/api/v1/admin/refund-cases?status=OPEN", headers=world.admin).json()[
            "items"
        ]
        == []
    )


def test_refund_reference_cannot_be_reused_for_another_payment(checkout):
    complete_payment(checkout)
    other = held(checkout, seat=1)
    second_payment = pay(checkout, booking=other, key=str(uuid.uuid4())).json()
    external_id = checkout["provider"].keys[second_payment["id"]]
    checkout["provider"].objects[external_id].update(status="succeeded", paid=True)
    assert notify(checkout, external_id).status_code == 200
    world = checkout["world"]
    assert (
        world.client.post(
            f"/api/v1/admin/routes/{checkout['route']['id']}/cancel",
            headers=world.admin,
            json={"reason": "Cancelled service"},
        ).status_code
        == 200
    )
    cases = world.client.get("/api/v1/admin/refund-cases", headers=world.admin).json()["items"]
    assert len(cases) == 2
    reference = "reference-" + uuid.uuid4().hex
    assert (
        world.client.post(
            f"/api/v1/admin/refund-cases/{cases[0]['id']}/record",
            headers=world.admin,
            json={"reference": reference},
        ).status_code
        == 200
    )
    response = world.client.post(
        f"/api/v1/admin/refund-cases/{cases[1]['id']}/record",
        headers=world.admin,
        json={"reference": reference},
    )
    assert response.status_code == 409 and response.json()["code"] == "REFUND_REFERENCE_USED"
    assert (
        asyncio.run(
            scalar(select(RefundCase.status).where(RefundCase.id == uuid.UUID(cases[1]["id"])))
        )
        == "OPEN"
    )


def test_notification_retry_generation_fences_concurrent_and_stale_requests(checkout):
    complete_payment(checkout)
    world = checkout["world"]
    path = "/api/v1/admin/notifications"
    rows = world.client.get(
        path, headers=world.admin, params={"booking_id": checkout["booking"]["id"]}
    ).json()["items"]
    item = rows[0]
    assert "recipient_email" not in item and "body" not in item and "lease_token" not in item
    retry_path = path + f"/{item['id']}/retry"
    body = {"expected_generation": 0, "reason": "SMTP configuration corrected"}
    assert world.client.post(retry_path, headers=world.admin, json=body).status_code == 409
    asyncio.run(
        change_record(
            Notification, item["id"], status="FAILED", attempts=8, last_error="SMTPException"
        )
    )
    assert world.client.post(retry_path, headers=checkout["headers"], json=body).status_code == 403
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(
                lambda _: world.client.post(retry_path, headers=world.admin, json=body), range(2)
            )
        )
    assert sorted(r.status_code for r in responses) == [200, 409]
    updated = next(r.json() for r in responses if r.status_code == 200)
    assert (
        updated["status"] == "PENDING"
        and updated["attempts"] == 0
        and updated["retry_generation"] == 1
    )
    assert audit_count(item["id"], "notification.retry_requested") == 1
    asyncio.run(change_record(Notification, item["id"], status="FAILED", attempts=8))
    assert world.client.post(retry_path, headers=world.admin, json=body).status_code == 409
    assert (
        world.client.post(
            retry_path, headers=world.admin, json={**body, "expected_generation": 1}
        ).status_code
        == 200
    )
    asyncio.run(change_record(Notification, item["id"], status="SENT", sent_at=datetime.now(UTC)))
    assert (
        world.client.post(
            retry_path, headers=world.admin, json={**body, "expected_generation": 2}
        ).status_code
        == 409
    )


def test_manual_verification_recovers_unknown_result_using_get_only(checkout):
    checkout["provider"].fail_after_create = True
    assert pay(checkout).status_code == 503
    payment_id = next(iter(checkout["provider"].keys))
    external_id = next(iter(checkout["provider"].objects))
    expire_time(checkout["booking"])
    succeed(checkout)
    asyncio.run(change_record(Payment, payment_id, review_reason="UNKNOWN_RESULT_REQUIRES_REVIEW"))
    world = checkout["world"]
    path = f"/api/v1/admin/payments/{payment_id}/verify"
    assert world.client.post(path, headers=world.admin, json={}).status_code == 409
    assert (
        world.client.post(
            path, headers=checkout["passengers"][0], json={"external_id": external_id}
        ).status_code
        == 403
    )
    verified = world.client.post(path, headers=world.admin, json={"external_id": external_id})
    assert verified.status_code == 200, verified.text
    assert (
        verified.json()["status"] == "SUCCEEDED"
        and verified.json()["review_reason"] == "REFUND_REQUIRED"
    )
    assert booking_state(checkout["booking"]) == "EXPIRED"
    assert get_case(checkout)["status"] == "OPEN"
    assert len(checkout["provider"].requests) == 1
    assert audit_count(payment_id, "payment.verification_requested") == 1
    assert (
        world.client.post(
            path, headers=world.admin, json={"external_id": str(uuid.uuid4())}
        ).status_code
        == 409
    )


def test_manual_verification_preserves_mismatch_then_accepts_verified_correction(checkout):
    payment = pay(checkout).json()
    obj = succeed(checkout)
    original_amount = obj["amount"]["value"]
    obj["amount"]["value"] = "1.00"
    world = checkout["world"]
    path = f"/api/v1/admin/payments/{payment['id']}/verify"
    response = world.client.post(path, headers=world.admin, json={})
    assert (
        response.status_code == 200 and response.json()["review_reason"] == "PROVIDER_DATA_MISMATCH"
    )
    assert booking_state(checkout["booking"]) == "HELD"
    obj["amount"]["value"] = original_amount
    response = world.client.post(path, headers=world.admin, json={})
    assert response.status_code == 200 and response.json()["review_reason"] is None
    assert booking_state(checkout["booking"]) == "PAID"


def test_verification_disabled_and_provider_failure_do_not_invent_success(checkout):
    payment = pay(checkout).json()
    world = checkout["world"]
    path = f"/api/v1/admin/payments/{payment['id']}/verify"
    world.client.app.state.settings.payments_enabled = False
    assert world.client.post(path, headers=world.admin, json={}).status_code == 503
    world.client.app.state.settings.payments_enabled = True
    checkout["provider"].fail_get = True
    assert world.client.post(path, headers=world.admin, json={}).status_code == 503
    assert booking_state(checkout["booking"]) == "HELD"
    assert len(checkout["provider"].requests) == 1


def test_record_late_refund_releases_remaining_hold(checkout):
    world = checkout["world"]
    pay(checkout)
    world.status(checkout["profile"]["id"], "BLOCKED")
    succeed(checkout)
    assert notify(checkout).status_code == 200
    assert booking_state(checkout["booking"]) == "HELD"
    case = get_case(checkout)
    response = world.client.post(
        f"/api/v1/admin/refund-cases/{case['id']}/record",
        headers=world.admin,
        json={"reference": "refund-" + uuid.uuid4().hex},
    )
    assert response.status_code == 200, response.text
    assert booking_state(checkout["booking"]) == "CANCELLED"
