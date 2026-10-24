import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from armeniabus.core.config import Settings
from armeniabus.main import create_app
from armeniabus.modules.cities.catalog import CITIES, aliases, resolve, search_aliases
from armeniabus.modules.routes.schemas import RouteCreate, RouteSearch
from tests.test_route_validation import valid_input


def test_catalog_is_bounded_and_shared_without_frontend_drift():
    assert 1 < len(CITIES) <= 100
    assert len({city["id"] for city in CITIES}) == len(CITIES)
    assert {city["country"] for city in CITIES} == {"RU", "AM"}
    path = Path(__file__).resolve().parent.parent / "frontend/src/features/cities/catalog.json"
    # Frontend sources are not copied into the Docker backend test image.
    if path.exists():
        assert json.loads(path.read_text(encoding="utf-8")) == CITIES


@pytest.mark.parametrize("city", CITIES, ids=lambda city: city["id"])
def test_every_language_and_alias_resolves_to_one_identity_with_country(city):
    assert set(city["names"]) == {"ru", "en", "hy"}
    for name in aliases(city):
        assert resolve(f"  {name.upper()}  ", city["country"])["id"] == city["id"]


def test_yerevan_variants_normalize_in_new_routes_and_in_search():
    for name in ("Yerevan", "Ереван", "Երևան", "Երեւան", "am-yerevan"):
        route = RouteCreate(**{**valid_input(), "destination": name})
        assert route.destination == "Ереван"
        values, country = search_aliases(name)
        assert country == "AM"
        assert {"yerevan", "ереван", "երևան", "երեւան"}.issubset(values)


def test_same_named_armavir_cities_do_not_merge():
    assert resolve("Armavir", "RU")["id"] == "ru-armavir"
    assert resolve("Արմավիր", "AM")["id"] == "am-armavir"
    with pytest.raises(ValueError):
        resolve("Armavir")
    with pytest.raises(ValidationError):
        RouteSearch(origin="Armavir", destination="Yerevan", date="2030-01-01")
    with pytest.raises(ValidationError):
        RouteCreate(**{**valid_input(), "origin": "am-yerevan"})


def test_public_catalog_does_not_require_a_database_or_authentication():
    settings = Settings(
        database_url="postgresql+asyncpg://user:password@127.0.0.1:1/missing",
        redis_url="redis://127.0.0.1:1/0",
        jwt_secret_key="catalog-test-secret-at-least-32-characters",
    )
    with TestClient(create_app(settings)) as client:
        result = client.get("/api/v1/cities", params={"q": "Երև", "country": "AM"})
        assert result.status_code == 200
        assert [city["id"] for city in result.json()["items"]] == ["am-yerevan"]
