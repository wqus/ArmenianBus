import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from armeniabus.core.config import Settings
from armeniabus.main import create_app
from armeniabus.modules.buses.layouts import CATALOG, LAYOUTS, MODELS
from armeniabus.modules.buses.schemas import BusCreate
from tests.test_carriers_integration import world as world
from tests.test_routes_integration import create, patch
from tests.test_routes_integration import journeys as journeys


@pytest.mark.parametrize("layout", LAYOUTS.values(), ids=LAYOUTS.keys())
def test_layout_has_exact_unique_numbering_and_one_space_per_cell(layout):
    numbers = [n for row in layout["rows"] for n in row if n is not None]
    assert len(numbers) == len(set(numbers)) == layout["capacity"]
    assert sorted(numbers) == list(range(1, layout["capacity"] + 1))
    assert all(len(row) == layout["columns"] for row in layout["rows"])
    assert layout["id"].endswith("-v1")


def test_catalog_models_reference_existing_layouts_and_browser_copy_matches():
    for model in MODELS.values():
        assert model["recommended_layout_id"] is None or model["recommended_layout_id"] in LAYOUTS
    path = Path(__file__).resolve().parent.parent / "frontend/src/features/vehicles/layouts.json"
    if path.exists():
        assert json.loads(path.read_text(encoding="utf-8")) == CATALOG


def test_new_layout_requires_confirmation_and_matching_capacity():
    valid = dict(name="Sprinter", capacity=19, layout_id="minibus-19-v1", layout_confirmed=True)
    assert BusCreate(**valid).layout_id == "minibus-19-v1"
    for changes in [
        dict(capacity=18),
        dict(layout_id="unknown"),
        dict(layout_confirmed=False),
        dict(vehicle_model_id="unknown"),
        dict(layout_id=None),
        dict(layout_confirmed="true"),
    ]:
        with pytest.raises(ValidationError):
            BusCreate(**{**valid, **changes})
    assert BusCreate(name="Legacy", capacity=2).layout_id is None


def test_layout_catalog_is_public_and_does_not_need_a_database():
    with TestClient(create_app(Settings())) as client:
        response = client.get("/api/v1/buses/layouts")
        assert response.status_code == 200
        assert response.json() == CATALOG


@pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test PostgreSQL")
def test_bus_layout_survives_rename_and_public_trip_preserves_seat_ids(journeys):
    client, headers = journeys["world"].client, journeys["headers"]
    data = dict(
        name="My van",
        capacity=8,
        layout_id="van-8-v1",
        vehicle_model_id="other",
        layout_confirmed=True,
    )
    for changes in [dict(capacity=9), dict(layout_confirmed=False)]:
        assert (
            client.post("/api/v1/buses", headers=headers, json={**data, **changes}).status_code
            == 422
        )
    response = client.post("/api/v1/buses", headers=headers, json=data)
    assert response.status_code == 201, response.text
    bus = response.json()
    assert bus["layout_id"] == "van-8-v1"
    assert len(bus["seats"]) == 8
    renamed = client.patch(f"/api/v1/buses/{bus['id']}", headers=headers, json={"name": "Renamed"})
    assert renamed.json()["seats"] == bus["seats"]
    assert renamed.json()["layout_id"] == bus["layout_id"]
    assert (
        client.patch(
            f"/api/v1/buses/{bus['id']}",
            headers=headers,
            json={"name": "Changed", "layout_id": "minibus-19-v1"},
        ).status_code
        == 422
    )
    route = create(journeys, bus_id=bus["id"])
    assert patch(journeys, route["id"], status="ACTIVE").status_code == 200
    availability = client.get(f"/api/v1/routes/{route['id']}/seats").json()
    assert availability["layout_id"] == "van-8-v1"
    assert availability["free_seats"] == 8
    assert [{"id": s["id"], "seat_number": s["seat_number"]} for s in availability["seats"]] == bus[
        "seats"
    ]
    # Untouched legacy records get no invented spatial arrangement.
    legacy = create(journeys)
    assert patch(journeys, legacy["id"], status="ACTIVE").status_code == 200
    assert client.get(f"/api/v1/routes/{legacy['id']}/seats").json()["layout_id"] is None
