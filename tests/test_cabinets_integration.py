import asyncio
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from armeniabus.core.config import Settings
from armeniabus.infrastructure.db.session import create_session_factory
from armeniabus.modules.bookings.models import Booking
from armeniabus.modules.notifications.models import Notification
from armeniabus.modules.notifications.outbox import enqueue
from armeniabus.modules.payments.refunds import RefundCase
from armeniabus.modules.routes.models import Route
from tests.test_bookings_integration import audit_count, booking_state, expire_time, held, reserve
from tests.test_bookings_integration import trip as trip
from tests.test_carriers_integration import scalar
from tests.test_carriers_integration import world as world
from tests.test_payments_integration import checkout as checkout
from tests.test_payments_integration import notify, pay, succeed
from tests.test_routes_integration import journeys as journeys
from tests.test_routes_integration import patch
from tests.test_search_integration import change_record

pytestmark = pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test PostgreSQL")


def complete_payment(context):
    payment = pay(context)
    assert payment.status_code == 200, payment.text
    succeed(context)
    assert notify(context).status_code == 200
    return payment.json()


def cabinet(context, *, passenger=0, **params):
    return context["world"].client.get(
        "/api/v1/cabinet/bookings", headers=context["passengers"][passenger], params=params
    )


def notification_count(booking, event):
    return asyncio.run(
        scalar(
            select(func.count())
            .select_from(Notification)
            .where(Notification.event_key == f"booking:{booking['id']}:{event}")
        )
    )


def refund_count(payment):
    return asyncio.run(
        scalar(
            select(func.count())
            .select_from(RefundCase)
            .where(RefundCase.payment_id == uuid.UUID(payment["id"]))
        )
    )


def test_hold_only_cancellation_cannot_cancel_a_payment_that_won_the_race(checkout):
    payment = complete_payment(checkout)
    booking = checkout["booking"]
    response = checkout["world"].client.delete(
        f"/api/v1/bookings/{booking['id']}?hold_only=true",
        headers=checkout["passengers"][0],
    )
    assert response.status_code == 409 and response.json()["code"] == "BOOKING_NOT_HELD"
    assert booking_state(booking) == "PAID"
    assert refund_count(payment) == 0
    assert audit_count(booking, "booking.cancelled") == 0


def test_cabinet_server_clock_and_hold_only_cancellation(trip):
    booking = held(trip)
    client, headers = trip["world"].client, trip["passengers"][0]
    path = f"/api/v1/cabinet/bookings/{booking['id']}"
    item = client.get(path, headers=headers).json()
    assert item["departure_timezone"] == "Europe/Moscow"
    assert item["boarding_address"] == trip["route"]["boarding_address"]
    assert item["dropoff_address"] == trip["route"]["dropoff_address"]
    assert (
        patch(trip, trip["route"]["id"], boarding_address="Другая автостанция").json()["code"]
        == "ROUTE_HAS_BOOKINGS"
    )
    assert datetime.fromisoformat(item["created_at"]) <= datetime.fromisoformat(item["server_time"])
    assert datetime.fromisoformat(item["server_time"]) < datetime.fromisoformat(item["held_until"])
    assert datetime.fromisoformat(
        cabinet(trip).json()["items"][0]["server_time"]
    ).utcoffset() == timedelta(0)
    cancel_path = f"/api/v1/bookings/{booking['id']}?hold_only=true"
    assert client.delete(cancel_path, headers=headers).status_code == 204
    assert client.delete(cancel_path, headers=headers).status_code == 204
    assert client.get(path, headers=headers).json()["status"] == "CANCELLED"
    expired = held(trip)
    expire_time(expired)
    item = client.get(f"/api/v1/cabinet/bookings/{expired['id']}", headers=headers).json()
    assert item["status"] == "EXPIRED"
    assert datetime.fromisoformat(item["server_time"]) >= datetime.fromisoformat(item["held_until"])


def test_paid_cancellation_is_atomic_idempotent_and_does_not_claim_refund(checkout):
    payment = complete_payment(checkout)
    client, booking = checkout["world"].client, checkout["booking"]
    item = cabinet(checkout, segment="upcoming").json()["items"][0]
    assert item["status"] == "PAID" and item["cancellation_allowed"]
    assert item["seat_number"] == 1 and item["origin"] == "Ростов-на-Дону"
    assert item["payment_status"] == "SUCCEEDED" and not item["refund_required"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(
                lambda _: client.delete(
                    f"/api/v1/bookings/{booking['id']}", headers=checkout["passengers"][0]
                ),
                range(2),
            )
        )
    assert [r.status_code for r in responses] == [204, 204]
    assert refund_count(payment) == 1 and notification_count(booking, "cancelled") == 1
    assert notification_count(booking, "paid") == 1
    body = asyncio.run(
        scalar(select(Notification.body).where(Notification.booking_id == uuid.UUID(booking["id"])))
    )
    assert "местное время, Europe/Moscow" in body
    assert checkout["route"]["boarding_address"] in body
    assert checkout["route"]["dropoff_address"] in body
    assert audit_count(booking, "booking.cancelled") == 1
    item = cabinet(checkout, segment="history").json()["items"][0]
    assert item["status"] == "CANCELLED" and item["refund_required"]
    assert item["payment_status"] == "SUCCEEDED" and not item["cancellation_allowed"]
    assert cabinet(checkout, segment="upcoming").json()["items"] == []
    successor = held(checkout, passenger=1)
    assert notify(checkout).status_code == 200
    assert booking_state(booking) == "CANCELLED" and booking_state(successor) == "HELD"
    assert refund_count(payment) == 1


def test_cutoff_rejects_without_side_effects_and_is_configurable(checkout):
    payment = complete_payment(checkout)
    asyncio.run(
        change_record(
            Route, checkout["route"]["id"], departure_at=datetime.now(UTC) + timedelta(hours=23)
        )
    )
    client, booking = checkout["world"].client, checkout["booking"]
    assert not cabinet(checkout).json()["items"][0]["cancellation_allowed"]
    response = client.delete(f"/api/v1/bookings/{booking['id']}", headers=checkout["passengers"][0])
    assert response.status_code == 409 and response.json()["code"] == "CANCELLATION_CUTOFF"
    assert booking_state(booking) == "PAID" and refund_count(payment) == 0
    assert notification_count(booking, "cancelled") == 0
    client.app.state.settings.paid_cancellation_cutoff_hours = 12
    assert cabinet(checkout).json()["items"][0]["cancellation_allowed"]
    assert (
        client.delete(
            f"/api/v1/bookings/{booking['id']}", headers=checkout["passengers"][0]
        ).status_code
        == 204
    )
    assert refund_count(payment) == 1


def test_payment_confirmation_racing_cancellation_preserves_refund(checkout):
    payment = pay(checkout).json()
    succeed(checkout)
    client, booking = checkout["world"].client, checkout["booking"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        confirmed = pool.submit(notify, checkout)
        cancelled = pool.submit(
            client.delete, f"/api/v1/bookings/{booking['id']}", headers=checkout["passengers"][0]
        )
        assert confirmed.result(timeout=15).status_code == 200
        assert cancelled.result(timeout=15).status_code == 204
    assert booking_state(booking) == "CANCELLED" and refund_count(payment) == 1
    assert notification_count(booking, "cancelled") == 1
    assert notify(checkout).status_code == 200
    assert refund_count(payment) == 1


def test_carrier_cancellation_refunds_paid_and_cancels_holds(checkout):
    payment = complete_payment(checkout)
    other = held(checkout, passenger=1, seat=1)
    for _ in range(2):
        assert patch(checkout, checkout["route"]["id"], status="CANCELLED").status_code == 200
    assert refund_count(payment) == 1
    for booking in (checkout["booking"], other):
        assert booking_state(booking) == "CANCELLED"
        assert notification_count(booking, "cancelled") == 1
    assert reserve(checkout).status_code == 404
    assert notify(checkout).status_code == 200
    assert booking_state(checkout["booking"]) == "CANCELLED"


def test_cabinets_effective_status_pagination_and_ownership(trip):
    first, second = held(trip), held(trip, seat=1)
    expire_time(first)
    client = trip["world"].client
    assert [b["id"] for b in cabinet(trip, segment="history").json()["items"]] == [first["id"]]
    assert cabinet(trip, status="EXPIRED").json()["items"][0]["status"] == "EXPIRED"
    assert not cabinet(trip, status="EXPIRED").json()["items"][0]["cancellation_allowed"]
    assert cabinet(trip, limit=1).json()["items"][0]["id"] == second["id"]
    assert cabinet(trip, limit=1, offset=1).json()["items"][0]["id"] == first["id"]
    assert cabinet(trip, passenger=1).json()["items"] == []
    path = f"/api/v1/cabinet/bookings/{first['id']}"
    assert client.get(path, headers=trip["passengers"][1]).status_code == 404
    assert client.get(path).status_code == 401
    assert client.get(path, headers=trip["headers"]).status_code == 403
    carrier_path = "/api/v1/carriers/me/bookings"
    own = client.get(
        carrier_path, headers=trip["headers"], params={"route_id": trip["route"]["id"]}
    )
    assert len(own.json()["items"]) == 2
    assert "email" not in own.text and "password" not in own.text
    assert client.get(carrier_path + f"/{first['id']}", headers=trip["headers"]).status_code == 200
    _, stranger = trip["world"].account()
    trip["world"].status(trip["world"].profile(stranger)["id"], "ACTIVE")
    assert client.get(carrier_path, headers=stranger).json()["items"] == []
    assert client.get(carrier_path + f"/{first['id']}", headers=stranger).status_code == 404
    assert (
        client.get(
            carrier_path, headers=stranger, params={"route_id": trip["route"]["id"]}
        ).status_code
        == 404
    )
    trip["world"].status(trip["profile"]["id"], "BLOCKED")
    assert client.get(carrier_path, headers=trip["headers"]).status_code == 403
    assert cabinet(trip, limit=101).status_code == 422


def test_late_payment_creates_admin_refund_case_once(checkout):
    payment = pay(checkout).json()
    expire_time(checkout["booking"])
    succeed(checkout)
    for _ in range(2):
        assert notify(checkout).status_code == 200
    assert refund_count(payment) == 1
    assert notification_count(checkout["booking"], "refund_required") == 1
    assert notification_count(checkout["booking"], "paid") == 0
    client = checkout["world"].client
    path = "/api/v1/admin/refund-cases"
    assert client.get(path).status_code == 401
    assert client.get(path, headers=checkout["passengers"][0]).status_code == 403
    assert client.get(path, headers=checkout["headers"]).status_code == 403
    items = client.get(path, headers=checkout["world"].admin).json()["items"]
    assert len(items) == 1 and items[0]["payment_id"] == payment["id"]
    assert items[0]["reason"] == "LATE_OR_UNAVAILABLE_BOOKING"


def test_outbox_rolls_back_with_booking_and_deduplicates(trip):
    booking = held(trip)

    async def exercise():
        engine, sessions = create_session_factory(Settings().database_url)
        try:
            async with sessions() as db:
                row = await db.get(Booking, uuid.UUID(booking["id"]))
                row.status = "CANCELLED"
                await enqueue(db, row, "cancelled")
                await db.rollback()
            async with sessions() as db:
                row = await db.get(Booking, uuid.UUID(booking["id"]))
                assert row.status == "HELD"
                assert not await db.scalar(
                    select(Notification.id).where(Notification.booking_id == row.id)
                )
                await enqueue(db, row, "paid")
                await enqueue(db, row, "paid")
                await db.commit()
        finally:
            await engine.dispose()

    asyncio.run(exercise())
    assert notification_count(booking, "paid") == 1
