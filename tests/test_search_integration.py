import asyncio
import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import create_async_engine

from armeniabus.core.config import Settings
from armeniabus.modules.buses.models import Bus
from armeniabus.modules.carriers.models import CarrierProfile
from armeniabus.modules.routes.models import Route
from armeniabus.modules.users.models import User
from tests.test_carriers_integration import world as world
from tests.test_routes_integration import create, patch
from tests.test_routes_integration import journeys as journeys

pytestmark = pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test PostgreSQL")


def publish(journeys, **changes):
    route = create(journeys, **changes)
    assert patch(journeys, route["id"], status="ACTIVE").status_code == 200
    return route


def query(route, **changes):
    return {
        "origin": route["origin"],
        "destination": route["destination"],
        "date": route["departure_at"][:10],
        **changes,
    }


def search(journeys, route, **changes):
    response = journeys["world"].client.get("/api/v1/routes/search", params=query(route, **changes))
    assert response.status_code == 200, response.text
    return response.json()


async def change_record(model, record_id, **values):
    engine = create_async_engine(Settings().database_url)
    try:
        async with engine.begin() as connection:
            await connection.execute(
                update(model).where(model.id == uuid.UUID(record_id)).values(**values)
            )
    finally:
        await engine.dispose()


def test_public_search_details_seats_and_owner_separation(journeys):
    client = journeys["world"].client
    route = publish(journeys)
    draft = create(journeys)
    page = search(journeys, route, origin="  РОСТОВ-НА-ДОНУ  ", destination="гЮмРи")
    assert [r["id"] for r in page["items"]] == [route["id"]]
    trip = page["items"][0]
    assert trip["price"] == "4500.50"
    assert trip["company_name"] == "Test Carrier"
    assert trip["bus_name"] == "First bus"
    assert trip["capacity"] == trip["free_seats"] == 2
    assert not {"email", "phone", "user_id", "password_hash"}.intersection(trip)
    assert client.get(f"/api/v1/routes/{route['id']}").json() == trip
    seats = client.get(f"/api/v1/routes/{route['id']}/seats").json()
    assert seats["route_id"] == route["id"] and seats["bus_id"] == route["bus_id"]
    assert seats["free_seats"] == 2
    assert [s["seat_number"] for s in seats["seats"]] == [1, 2]
    assert {s["status"] for s in seats["seats"]} == {"FREE"}
    stored_seats = journeys["buses"][0]["seats"]
    assert [s["id"] for s in seats["seats"]] == [s["id"] for s in stored_seats]
    for suffix in ("", "/seats"):
        assert client.get(f"/api/v1/routes/{draft['id']}{suffix}").status_code == 404
    assert client.get(f"/api/v1/routes/my/{draft['id']}").status_code == 401
    assert (
        client.get(f"/api/v1/routes/my/{draft['id']}", headers=journeys["headers"]).status_code
        == 200
    )
    assert search(journeys, route, origin="%")["items"] == []
    assert search(journeys, route, destination="Гюм")["items"] == []
    assert search(journeys, route, origin="' OR 1=1 --")["items"] == []


def test_multilingual_search_finds_legacy_names_and_keeps_country_identity(journeys):
    route = publish(journeys, origin="Moscow", destination="Yerevan")
    assert route["origin"] == "Москва"
    assert route["destination"] == "Ереван"
    # Existing deployments can still contain the old free-text spellings.
    asyncio.run(change_record(Route, route["id"], origin="Moscow", destination="Yerevan"))
    for origin, destination in [
        ("Москва", "Ереван"),
        ("Մոսկվա", "Երևան"),
        ("ru-moscow", "am-yerevan"),
        ("MOSCOW", "Երեւան"),
    ]:
        assert [
            r["id"]
            for r in search(journeys, route, origin=origin, destination=destination)["items"]
        ] == [route["id"]]
    armavir = publish(journeys, origin="ru-armavir", destination="Ереван")
    assert [r["id"] for r in search(journeys, armavir, origin="ru-armavir")["items"]] == [
        armavir["id"]
    ]
    response = journeys["world"].client.get(
        "/api/v1/routes/search", params=query(armavir, origin="Armavir")
    )
    assert response.status_code == 422


def test_utc_day_boundaries_and_stable_pagination(journeys):
    day = (datetime.now(UTC) + timedelta(days=5)).replace(hour=0, minute=0, second=0, microsecond=0)
    before = publish(journeys, departure_at=(day - timedelta(microseconds=1)).isoformat())
    first = publish(journeys, departure_at=day.isoformat())
    tied = publish(journeys, departure_at=day.isoformat())
    last = publish(journeys, departure_at=(day + timedelta(days=1, microseconds=-1)).isoformat())
    after = publish(journeys, departure_at=(day + timedelta(days=1)).isoformat())
    expected = sorted([first["id"], tied["id"]]) + [last["id"]]
    assert [r["id"] for r in search(journeys, first)["items"]] == expected
    assert [r["id"] for r in search(journeys, first, limit=1, offset=1)["items"]] == expected[1:2]
    assert search(journeys, first, offset=3)["items"] == []
    assert [r["id"] for r in search(journeys, before)["items"]] == [before["id"]]
    assert [r["id"] for r in search(journeys, after)["items"]] == [after["id"]]
    reverse = publish(
        journeys,
        origin_country="AM",
        destination_country="RU",
        origin="Գյումրի",
        destination="Псков",
        departure_at=day.isoformat(),
    )
    assert [r["id"] for r in search(journeys, reverse)["items"]] == [reverse["id"]]


@pytest.mark.parametrize(
    "hidden_by",
    [
        "cancelled",
        "departed",
        "completed",
        "past",
        "archived_route",
        "archived_bus",
        "blocked_carrier",
        "pending_carrier",
        "blocked_user",
    ],
)
def test_unavailable_trips_are_hidden_consistently(journeys, hidden_by):
    route = publish(journeys)
    client = journeys["world"].client
    assert len(search(journeys, route)["items"]) == 1
    if hidden_by in {"cancelled", "departed", "completed"}:
        asyncio.run(change_record(Route, route["id"], status=hidden_by.upper()))
    elif hidden_by == "past":
        asyncio.run(
            change_record(Route, route["id"], departure_at=datetime.now(UTC) - timedelta(seconds=1))
        )
    elif hidden_by == "archived_route":
        asyncio.run(change_record(Route, route["id"], archived_at=datetime.now(UTC)))
    elif hidden_by == "archived_bus":
        asyncio.run(change_record(Bus, route["bus_id"], archived_at=datetime.now(UTC)))
    elif hidden_by in {"blocked_carrier", "pending_carrier"}:
        asyncio.run(
            change_record(
                CarrierProfile, journeys["profile"]["id"], status=hidden_by.split("_")[0].upper()
            )
        )
    else:
        asyncio.run(change_record(User, journeys["profile"]["user_id"], status="BLOCKED"))
    assert search(journeys, route)["items"] == []
    for suffix in ("", "/seats"):
        response = client.get(f"/api/v1/routes/{route['id']}{suffix}")
        assert response.status_code == 404
        assert response.json()["code"] == "ROUTE_NOT_FOUND"
        assert client.get(f"/api/v1/routes/{uuid.uuid4()}{suffix}").status_code == 404


def test_query_validation_returns_standard_errors(world):
    valid = {"origin": "Ереван", "destination": "Москва", "date": "2030-01-01"}
    for changes in [
        {"origin": " "},
        {"destination": "x" * 201},
        {"date": "bad"},
        {"date": "9999-12-31"},
        {"limit": 0},
        {"limit": 101},
        {"offset": -1},
        {"offset": 10001},
        {"status": "DRAFT"},
    ]:
        response = world.client.get("/api/v1/routes/search", params={**valid, **changes})
        assert response.status_code == 422, response.text
        assert response.json()["code"] == "VALIDATION_ERROR"
        assert response.json()["request_id"]
    assert world.client.get("/api/v1/routes/search").status_code == 422
    assert world.client.get("/api/v1/routes/search", params=valid).json()["items"] == []
