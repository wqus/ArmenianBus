import asyncio
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import func, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from armeniabus.core.config import Settings
from armeniabus.modules.admin.models import AuditLog
from armeniabus.modules.buses.models import Bus
from armeniabus.modules.routes.models import Route
from tests.test_carriers_integration import scalar
from tests.test_carriers_integration import world as world

pytestmark = pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test PostgreSQL")


@pytest.fixture
def journeys(world):
    _, headers = world.account()
    profile = world.profile(headers)
    assert world.status(profile["id"], "ACTIVE").status_code == 200
    buses = []
    for name in ("First bus", "Second bus"):
        response = world.client.post(
            "/api/v1/buses", headers=headers, json={"name": name, "capacity": 2}
        )
        assert response.status_code == 201
        buses.append(response.json())
    return {"world": world, "headers": headers, "profile": profile, "buses": buses}


def payload(journeys, **changes):
    departure = (datetime.now(UTC) + timedelta(days=2)).astimezone(timezone(timedelta(hours=3)))
    return {
        "bus_id": journeys["buses"][0]["id"],
        "origin_country": "RU",
        "destination_country": "AM",
        "origin": "  Ростов-на-Дону  ",
        "destination": "Гюмри",
        "departure_at": departure.isoformat(),
        "price": "4500.50",
        **changes,
    }


def create(journeys, **changes):
    response = journeys["world"].client.post(
        "/api/v1/routes", headers=journeys["headers"], json=payload(journeys, **changes)
    )
    assert response.status_code == 201, response.text
    return response.json()


def patch(journeys, route_id, **changes):
    return journeys["world"].client.patch(
        f"/api/v1/routes/{route_id}", headers=journeys["headers"], json=changes
    )


async def move_departure_into_past(route_id):
    """Simulate passage of time only in the isolated test database."""
    engine = create_async_engine(Settings().database_url)
    try:
        async with engine.begin() as connection:
            await connection.execute(
                update(Route)
                .where(Route.id == uuid.UUID(route_id))
                .values(departure_at=datetime.now(UTC) - timedelta(minutes=1))
            )
    finally:
        await engine.dispose()


def test_create_edit_dynamic_direction_exact_price_and_pagination(journeys):
    client, headers = journeys["world"].client, journeys["headers"]
    route = create(journeys)
    assert route["status"] == "DRAFT"
    assert route["origin"] == "Ростов-на-Дону"
    assert route["price"] == "4500.50"
    assert route["currency"] == "RUB"
    instant = datetime.fromisoformat(route["departure_at"].replace("Z", "+00:00"))
    assert instant.utcoffset() == timedelta(0)
    stored = asyncio.run(scalar(select(Route.price).where(Route.id == uuid.UUID(route["id"]))))
    assert stored == Decimal("4500.50") and isinstance(stored, Decimal)
    assert patch(journeys, route["id"], status="ACTIVE").status_code == 200
    changed = patch(
        journeys,
        route["id"],
        price="5999.90",
        bus_id=journeys["buses"][1]["id"],
        origin_country="AM",
        destination_country="RU",
        origin="Горис",
        destination="Псков",
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["price"] == "5999.90"
    assert changed.json()["status"] == "ACTIVE"
    assert changed.json()["origin"] == "Горис"
    unchanged = patch(journeys, route["id"], origin_country="RU")
    assert unchanged.status_code == 422
    assert (
        client.get(f"/api/v1/routes/my/{route['id']}", headers=headers).json()["origin_country"]
        == "AM"
    )
    second = create(journeys, departure_at=(datetime.now(UTC) + timedelta(days=3)).isoformat())
    page = client.get("/api/v1/routes/my?limit=1&offset=1", headers=headers)
    assert page.status_code == 200
    assert [item["id"] for item in page.json()["items"]] == [second["id"]]
    active = client.get("/api/v1/routes/my?status=ACTIVE", headers=headers).json()
    assert [item["id"] for item in active["items"]] == [route["id"]]


def test_route_state_machine_and_time_guards(journeys):
    client, headers = journeys["world"].client, journeys["headers"]
    route = create(journeys)
    route_id = route["id"]
    assert patch(journeys, route_id, status="DEPARTED").status_code == 409
    assert patch(journeys, route_id, status="ACTIVE").status_code == 200
    assert patch(journeys, route_id, status="COMPLETED").status_code == 409
    assert patch(journeys, route_id, status="DEPARTED").status_code == 409
    bus_path = f"/api/v1/buses/{route['bus_id']}"
    assert client.delete(bus_path, headers=headers).status_code == 409
    asyncio.run(move_departure_into_past(route_id))
    assert patch(journeys, route_id, price="9999").status_code == 409
    assert patch(journeys, route_id, status="DEPARTED").status_code == 200
    assert client.delete(f"/api/v1/routes/{route_id}", headers=headers).status_code == 409
    assert patch(journeys, route_id, status="COMPLETED").status_code == 200
    assert patch(journeys, route_id, status="COMPLETED").status_code == 200
    assert patch(journeys, route_id, status="ACTIVE").status_code == 409
    assert patch(journeys, route_id, price="100").status_code == 409
    assert client.delete(bus_path, headers=headers).status_code == 204
    assert (
        client.get(f"/api/v1/routes/my/{route_id}", headers=headers).json()["status"] == "COMPLETED"
    )
    assert (
        asyncio.run(
            scalar(
                select(func.count())
                .select_from(AuditLog)
                .where(
                    AuditLog.entity_id == uuid.UUID(route_id),
                    AuditLog.action == "route.status_changed",
                )
            )
        )
        == 3
    )


def test_draft_archiving_and_active_cancellation_preserve_history(journeys):
    client, headers = journeys["world"].client, journeys["headers"]
    draft = create(journeys)
    draft_path = f"/api/v1/routes/{draft['id']}"
    assert client.delete(f"/api/v1/buses/{draft['bus_id']}", headers=headers).status_code == 409
    assert client.delete(draft_path, headers=headers).status_code == 204
    assert client.delete(draft_path, headers=headers).status_code == 204
    assert (
        client.get(draft_path.replace("/routes/", "/routes/my/"), headers=headers).status_code
        == 404
    )
    assert patch(journeys, draft["id"], status="ACTIVE").status_code == 404
    assert asyncio.run(scalar(select(Route.archived_at).where(Route.id == uuid.UUID(draft["id"]))))
    assert client.get("/api/v1/routes/my", headers=headers).json()["items"] == []
    route = create(journeys)
    assert patch(journeys, route["id"], status="ACTIVE").status_code == 200
    path = f"/api/v1/routes/{route['id']}"
    assert client.delete(path, headers=headers).status_code == 204
    assert client.delete(path, headers=headers).status_code == 204
    assert (
        client.get(path.replace("/routes/", "/routes/my/"), headers=headers).json()["status"]
        == "CANCELLED"
    )
    assert patch(journeys, route["id"], status="ACTIVE").status_code == 409
    assert patch(journeys, route["id"], destination="Ереван").status_code == 409
    assert client.delete(f"/api/v1/buses/{route['bus_id']}", headers=headers).status_code == 204


def test_route_ownership_and_unavailable_buses(journeys):
    world = journeys["world"]
    client, headers = world.client, journeys["headers"]
    _, stranger = world.account()
    assert world.status(world.profile(stranger)["id"], "ACTIVE").status_code == 200
    foreign_bus = client.post(
        "/api/v1/buses", headers=stranger, json={"name": "Foreign", "capacity": 2}
    ).json()
    route = create(journeys)
    path = f"/api/v1/routes/{route['id']}"
    assert (
        client.post(
            "/api/v1/routes", headers=headers, json=payload(journeys, bus_id=foreign_bus["id"])
        ).status_code
        == 404
    )
    assert patch(journeys, route["id"], bus_id=foreign_bus["id"]).status_code == 404
    for method, body in [("get", None), ("patch", {"price": "100"}), ("delete", None)]:
        endpoint = path.replace("/routes/", "/routes/my/") if method == "get" else path
        response = client.request(method, endpoint, headers=stranger, json=body)
        assert response.status_code == 404
    assert client.get("/api/v1/routes/my", headers=stranger).json()["items"] == []
    assert client.get(path.replace("/routes/", "/routes/my/")).status_code == 401
    _, passenger = world.account("PASSENGER")
    assert (
        client.post("/api/v1/routes", headers=passenger, json=payload(journeys)).status_code == 403
    )
    second_bus = journeys["buses"][1]["id"]
    assert client.delete(f"/api/v1/buses/{second_bus}", headers=headers).status_code == 204
    assert (
        client.post(
            "/api/v1/routes", headers=headers, json=payload(journeys, bus_id=second_bus)
        ).status_code
        == 404
    )
    assert world.status(journeys["profile"]["id"], "BLOCKED").status_code == 200
    for method, endpoint, body in [
        ("get", path.replace("/routes/", "/routes/my/"), None),
        ("get", "/api/v1/routes/my", None),
        ("post", "/api/v1/routes", payload(journeys)),
        ("patch", path, {"status": "ACTIVE"}),
        ("delete", path, None),
    ]:
        assert client.request(method, endpoint, headers=headers, json=body).status_code == 403


def test_reject_past_departure_and_publishing_expired_draft(journeys):
    client, headers = journeys["world"].client, journeys["headers"]
    past = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    rejected = client.post(
        "/api/v1/routes", headers=headers, json=payload(journeys, departure_at=past)
    )
    assert rejected.status_code == 422
    assert rejected.json()["code"] == "DEPARTURE_IN_PAST"
    route = create(journeys)
    assert patch(journeys, route["id"], departure_at=past).status_code == 422
    asyncio.run(move_departure_into_past(route["id"]))
    assert patch(journeys, route["id"], status="ACTIVE").status_code == 409


def test_bus_archival_racing_route_creation_is_consistent(journeys):
    client, headers = journeys["world"].client, journeys["headers"]
    bus_id = journeys["buses"][0]["id"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        create_future = pool.submit(
            client.post, "/api/v1/routes", headers=headers, json=payload(journeys)
        )
        archive_future = pool.submit(client.delete, f"/api/v1/buses/{bus_id}", headers=headers)
        created, archived = create_future.result(), archive_future.result()
    assert (created.status_code, archived.status_code) in {(201, 409), (404, 204)}
    stored_archive = asyncio.run(scalar(select(Bus.archived_at).where(Bus.id == uuid.UUID(bus_id))))
    count = asyncio.run(
        scalar(select(func.count()).select_from(Route).where(Route.bus_id == uuid.UUID(bus_id)))
    )
    assert (stored_archive is None and count == 1) or (stored_archive is not None and count == 0)


async def insert_mismatched_owner(journeys, foreign_bus_id):
    engine = create_async_engine(Settings().database_url)
    data = payload(journeys, bus_id=uuid.UUID(foreign_bus_id))
    data["departure_at"] = datetime.fromisoformat(data["departure_at"])
    data.update(carrier_id=uuid.UUID(journeys["profile"]["id"]), currency="RUB", status="DRAFT")
    try:
        async with engine.begin() as connection:
            await connection.execute(insert(Route).values(**data))
    finally:
        await engine.dispose()


def test_database_rejects_cross_carrier_bus_reference(journeys):
    world = journeys["world"]
    _, stranger = world.account()
    assert world.status(world.profile(stranger)["id"], "ACTIVE").status_code == 200
    foreign = world.client.post(
        "/api/v1/buses", headers=stranger, json={"name": "Foreign", "capacity": 2}
    ).json()
    with pytest.raises(IntegrityError, match="fk_routes_owned_bus"):
        asyncio.run(insert_mismatched_owner(journeys, foreign["id"]))
