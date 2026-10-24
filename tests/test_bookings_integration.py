import asyncio
import os
import subprocess
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, insert, select
from sqlalchemy.exc import IntegrityError

from armeniabus.core.config import Settings
from armeniabus.infrastructure.db.session import create_session_factory
from armeniabus.modules.admin.models import AuditLog
from armeniabus.modules.bookings.lifecycle import expire_batch
from armeniabus.modules.bookings.models import Booking
from armeniabus.modules.routes.models import Route
from tests.test_carriers_integration import scalar
from tests.test_carriers_integration import world as world
from tests.test_routes_integration import create, patch
from tests.test_routes_integration import journeys as journeys
from tests.test_search_integration import change_record, publish, search

pytestmark = pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test PostgreSQL")


@pytest.fixture
def trip(journeys):
    journeys["route"] = publish(journeys)
    journeys["passengers"] = [journeys["world"].account("PASSENGER")[1] for _ in range(2)]
    return journeys


def reserve(trip, *, passenger=0, seat=0, route=None, **extra):
    return trip["world"].client.post(
        "/api/v1/bookings",
        headers=trip["passengers"][passenger],
        json={
            "route_id": (route or trip["route"])["id"],
            "seat_id": trip["buses"][0]["seats"][seat]["id"],
            "passenger_first_name": "Արամ",
            "passenger_last_name": "Петросян",
            "passenger_phone": "+37499123456",
            **extra,
        },
    )


def held(trip, **options):
    response = reserve(trip, **options)
    assert response.status_code == 201, response.text
    return response.json()


def booking_state(booking):
    return asyncio.run(scalar(select(Booking.status).where(Booking.id == uuid.UUID(booking["id"]))))


def expire_time(booking):
    asyncio.run(
        change_record(Booking, booking["id"], held_until=datetime.now(UTC) - timedelta(seconds=1))
    )


def audit_count(booking, action):
    return asyncio.run(
        scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.entity_id == uuid.UUID(booking["id"]), AuditLog.action == action)
        )
    )


def test_hold_snapshot_availability_ownership_and_cancellation(trip):
    client = trip["world"].client
    booking = held(trip)
    assert booking["status"] == "HELD" and booking["amount"] == "4500.50"
    assert booking["currency"] == "RUB"
    assert datetime.fromisoformat(booking["held_until"]) - datetime.fromisoformat(
        booking["created_at"]
    ) == timedelta(minutes=10)
    path = f"/api/v1/bookings/{booking['id']}"
    owner, stranger = trip["passengers"]
    assert client.get(path, headers=owner).json() == booking
    assert client.get(path, headers=stranger).status_code == 404
    assert client.delete(path, headers=stranger).status_code == 404
    assert client.get(path).status_code == 401
    assert client.get(path, headers=trip["headers"]).status_code == 403
    assert client.get("/api/v1/bookings/my", headers=stranger).json()["items"] == []
    assert client.get("/api/v1/bookings/my", headers=owner).json()["items"] == [booking]
    assert search(trip, trip["route"])["items"][0]["free_seats"] == 1
    route_path = f"/api/v1/routes/{trip['route']['id']}"
    assert client.get(route_path).json()["free_seats"] == 1
    assert [s["status"] for s in client.get(route_path + "/seats").json()["seats"]] == [
        "HELD",
        "FREE",
    ]
    assert reserve(trip, passenger=1).status_code == 409
    assert patch(trip, trip["route"]["id"], price="9999").json()["code"] == "ROUTE_HAS_BOOKINGS"
    assert client.delete(path, headers=owner).status_code == 204
    assert client.delete(path, headers=owner).status_code == 204
    assert booking_state(booking) == "CANCELLED" and audit_count(booking, "booking.cancelled") == 1
    assert patch(trip, trip["route"]["id"], destination="Ереван").status_code == 409
    assert client.get(route_path).json()["free_seats"] == 2
    successor = held(trip, passenger=1)
    assert successor["id"] != booking["id"]
    assert client.get(path, headers=owner).json()["amount"] == "4500.50"


def test_passenger_contacts_are_private_persisted_and_excluded_from_audit(trip):
    booking = held(trip, passenger_first_name=" Արամ ", passenger_phone="+374 (99) 123-456")
    expected = {
        "passenger_first_name": "Արամ",
        "passenger_last_name": "Петросян",
        "passenger_phone": "+37499123456",
    }
    client = trip["world"].client
    path = f"/api/v1/cabinet/bookings/{booking['id']}"
    for url, headers in [
        (path, trip["passengers"][0]),
        (f"/api/v1/carriers/me/bookings/{booking['id']}", trip["headers"]),
    ]:
        response = client.get(url, headers=headers)
        assert response.status_code == 200, response.text
        assert {key: response.json()[key] for key in expected} == expected
    assert client.get(path, headers=trip["passengers"][1]).status_code == 404
    public = client.get(f"/api/v1/routes/{booking['route_id']}").text
    seats = client.get(f"/api/v1/routes/{booking['route_id']}/seats").text
    assert all(value not in public + seats for value in expected.values())
    audit = asyncio.run(
        scalar(
            select(AuditLog.event_data).where(
                AuditLog.entity_id == uuid.UUID(booking["id"]), AuditLog.action == "booking.created"
            )
        )
    )
    assert audit == {}


def test_invalid_passenger_contact_does_not_hold_a_seat(trip):
    response = reserve(trip, passenger_phone="12345")
    assert response.status_code == 422
    assert "12345" not in response.text
    assert search(trip, trip["route"])["items"][0]["free_seats"] == 2


def test_fifty_concurrent_requests_have_one_winner_without_redis(trip):
    client = trip["world"].client
    gate = threading.Barrier(50)

    class UnavailableRedis:
        def __getattr__(self, name):
            raise AssertionError("Booking must not depend on Redis")

    redis = client.app.state.redis
    client.app.state.redis = UnavailableRedis()
    try:

        def attempt(index):
            gate.wait(timeout=30)
            return reserve(trip, passenger=index % 2)

        with ThreadPoolExecutor(max_workers=50) as pool:
            results = list(pool.map(attempt, range(50)))
        assert [r.status_code for r in results].count(201) == 1
        losers = [r for r in results if r.status_code != 201]
        assert len(losers) == 49
        assert all(r.status_code == 409 and r.json()["code"] == "BOOKING_CONFLICT" for r in losers)
        assert client.get(f"/api/v1/routes/{trip['route']['id']}/seats").json()["free_seats"] == 1
    finally:
        client.app.state.redis = redis
    count = asyncio.run(
        scalar(
            select(func.count())
            .select_from(Booking)
            .where(
                Booking.route_id == uuid.UUID(trip["route"]["id"]),
                Booking.status.in_(["HELD", "PAID"]),
            )
        )
    )
    assert count == 1


def test_expired_hold_is_free_and_replaced_without_waiting_for_worker(trip):
    client = trip["world"].client
    previous = held(trip)
    expire_time(previous)
    assert booking_state(previous) == "HELD"
    assert search(trip, trip["route"])["items"][0]["free_seats"] == 2
    path = f"/api/v1/bookings/{previous['id']}"
    assert client.get(path, headers=trip["passengers"][0]).json()["status"] == "EXPIRED"
    assert (
        client.get("/api/v1/bookings/my", headers=trip["passengers"][0]).json()["items"][0][
            "status"
        ]
        == "EXPIRED"
    )
    successor = held(trip, passenger=1)
    assert successor["id"] != previous["id"]
    assert booking_state(previous) == "EXPIRED"
    assert patch(trip, trip["route"]["id"], price="9999").status_code == 409
    assert audit_count(previous, "booking.expired") == 1
    assert client.delete(path, headers=trip["passengers"][0]).status_code == 204
    assert booking_state(previous) == "EXPIRED"


async def parallel_expiry():
    engine, sessions = create_session_factory(Settings().database_url)

    async def run():
        async with sessions() as db:
            return await expire_batch(db, 1)

    try:
        return await asyncio.gather(run(), run())
    finally:
        await engine.dispose()


def test_worker_is_idempotent_and_does_not_expire_paid_bookings(trip):
    expired, paid = held(trip), held(trip, seat=1)
    expire_time(expired)
    expire_time(paid)
    asyncio.run(change_record(Booking, paid["id"], status="PAID"))
    assert sum(asyncio.run(parallel_expiry())) == 1
    assert sum(asyncio.run(parallel_expiry())) == 0
    assert booking_state(expired) == "EXPIRED"
    assert booking_state(paid) == "PAID"
    assert audit_count(expired, "booking.expired") == 1
    result = subprocess.run(
        [sys.executable, "-m", "armeniabus.worker", "--once"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "Expired holds: 0" in result.stdout + result.stderr
    client = trip["world"].client
    assert [
        s["status"]
        for s in client.get(f"/api/v1/routes/{trip['route']['id']}/seats").json()["seats"]
    ] == ["FREE", "PAID"]
    assert reserve(trip, passenger=1, seat=1).status_code == 409
    assert (
        client.delete(f"/api/v1/bookings/{paid['id']}", headers=trip["passengers"][0]).status_code
        == 409
    )
    assert (
        patch(trip, trip["route"]["id"], status="CANCELLED").json()["code"]
        == "ROUTE_HAS_PAID_BOOKINGS"
    )
    assert booking_state(paid) == "PAID"
    asyncio.run(
        change_record(
            Route, trip["route"]["id"], departure_at=datetime.now(UTC) - timedelta(seconds=1)
        )
    )
    assert patch(trip, trip["route"]["id"], status="DEPARTED").status_code == 200
    assert patch(trip, trip["route"]["id"], status="COMPLETED").status_code == 200
    assert booking_state(paid) == "COMPLETED"
    assert audit_count(paid, "booking.completed") == 1


def test_same_bus_seat_is_independent_for_different_routes(trip):
    first = held(trip)
    other = publish(trip)
    assert search(trip, trip["route"])["items"]
    assert trip["world"].client.get(f"/api/v1/routes/{other['id']}").json()["free_seats"] == 2
    second = held(trip, route=other)
    assert second["route_id"] != first["route_id"] and second["seat_id"] == first["seat_id"]


def test_input_validation_and_unbookable_trips(trip):
    client = trip["world"].client
    assert reserve(trip, amount="1").status_code == 422
    assert reserve(trip, status="PAID").status_code == 422
    assert reserve(trip, passenger_id=str(uuid.uuid4())).status_code == 422
    assert reserve(trip, seat_id=trip["buses"][1]["seats"][0]["id"]).status_code == 404
    draft = create(trip)
    assert reserve(trip, route=draft).status_code == 404
    assert reserve(trip, route={"id": str(uuid.uuid4())}).status_code == 404
    payload = {"route_id": trip["route"]["id"], "seat_id": trip["buses"][0]["seats"][0]["id"]}
    assert client.post("/api/v1/bookings", json=payload).status_code == 401
    assert client.post("/api/v1/bookings", json=payload, headers=trip["headers"]).status_code == 403
    assert trip["world"].status(trip["profile"]["id"], "BLOCKED").status_code == 200
    assert reserve(trip).status_code == 404
    assert trip["world"].status(trip["profile"]["id"], "ACTIVE").status_code == 200
    asyncio.run(
        change_record(
            Route, trip["route"]["id"], departure_at=datetime.now(UTC) - timedelta(seconds=1)
        )
    )
    assert reserve(trip).json()["code"] == "ROUTE_NOT_BOOKABLE"


def test_hold_ttl_configuration_and_departure_cap(trip):
    client = trip["world"].client
    settings = client.app.state.settings
    original = settings.booking_hold_minutes
    settings.booking_hold_minutes = 3
    try:
        booking = held(trip)
        assert datetime.fromisoformat(booking["held_until"]) - datetime.fromisoformat(
            booking["created_at"]
        ) == timedelta(minutes=3)
    finally:
        settings.booking_hold_minutes = original
    soon = publish(trip, departure_at=(datetime.now(UTC) + timedelta(minutes=1)).isoformat())
    capped = held(trip, route=soon)
    assert capped["held_until"] == soon["departure_at"]


def test_route_cancel_releases_holds_atomically_and_cannot_restore_them(trip):
    booking = held(trip)
    assert patch(trip, trip["route"]["id"], status="CANCELLED").status_code == 200
    assert booking_state(booking) == "CANCELLED"
    assert audit_count(booking, "booking.cancelled") == 1
    assert reserve(trip).status_code == 404
    assert patch(trip, trip["route"]["id"], status="ACTIVE").status_code == 409


def test_booking_racing_route_price_edit_is_consistent(trip):
    gate = threading.Barrier(2)

    def book():
        gate.wait(timeout=10)
        return reserve(trip)

    def edit():
        gate.wait(timeout=10)
        return patch(trip, trip["route"]["id"], price="9000.50")

    with ThreadPoolExecutor(max_workers=2) as pool:
        booked, edited = pool.submit(book), pool.submit(edit)
        booking, change = booked.result(), edited.result()
    assert booking.status_code == 201
    assert (change.status_code, booking.json()["amount"]) in {(200, "9000.50"), (409, "4500.50")}
    assert patch(trip, trip["route"]["id"], bus_id=trip["buses"][1]["id"]).status_code == 409


def test_booking_racing_route_cancellation_leaves_no_live_hold(trip):
    with ThreadPoolExecutor(max_workers=2) as pool:
        book = pool.submit(reserve, trip)
        cancel = pool.submit(patch, trip, trip["route"]["id"], status="CANCELLED")
        booking, cancelled = book.result(), cancel.result()
    assert cancelled.status_code == 200
    assert booking.status_code in (201, 404)
    assert (
        asyncio.run(
            scalar(
                select(func.count())
                .select_from(Booking)
                .where(Booking.route_id == uuid.UUID(trip["route"]["id"]), Booking.status == "HELD")
            )
        )
        == 0
    )


async def raw_insert(booking, passenger_id, **changes):
    engine, sessions = create_session_factory(Settings().database_url)
    values = {key: uuid.UUID(booking[key]) for key in ("route_id", "bus_id", "seat_id")}
    values.update(
        passenger_id=passenger_id,
        amount=booking["amount"],
        currency="RUB",
        status="HELD",
        held_until=datetime.now(UTC) + timedelta(minutes=10),
        **changes,
    )
    try:
        async with engine.begin() as connection:
            await connection.execute(insert(Booking).values(**values))
    finally:
        await engine.dispose()


def test_database_rejects_duplicate_active_booking_and_wrong_bus_seat(trip):
    booking = held(trip)
    passenger_id = asyncio.run(
        scalar(select(Booking.passenger_id).where(Booking.id == uuid.UUID(booking["id"])))
    )
    with pytest.raises(IntegrityError, match="uq_booking_active_seat"):
        asyncio.run(raw_insert(booking, passenger_id))
    with pytest.raises(IntegrityError, match="fk_booking_seat_bus"):
        asyncio.run(
            raw_insert(booking, passenger_id, seat_id=uuid.UUID(trip["buses"][1]["seats"][0]["id"]))
        )
