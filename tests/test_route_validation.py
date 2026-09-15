import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from pydantic import ValidationError

from armeniabus.modules.routes.schemas import RouteCreate, RouteUpdate


def valid_input():
    return {
        "bus_id": str(uuid.uuid4()),
        "origin_country": "RU",
        "destination_country": "AM",
        "origin": "Псков",
        "destination": "Горис",
        "departure_at": "2030-06-01T12:00:00+03:00",
        "price": "1234.50",
    }


def test_price_remains_decimal_and_departure_is_normalized_to_utc():
    route = RouteCreate(**valid_input())
    assert route.price == Decimal("1234.50")
    assert isinstance(route.price, Decimal)
    assert route.departure_at == datetime(2030, 6, 1, 9, tzinfo=UTC)
    assert route.departure_at.tzinfo == UTC


@pytest.mark.parametrize(
    "changes",
    [
        {"price": 1234.5},
        {"price": True},
        {"price": "1.001"},
        {"price": "0"},
        {"price": "-5"},
        {"price": "NaN"},
        {"price": "10000000000.00"},
        {"departure_at": "2030-06-01T12:00:00"},
        {"departure_at": 1900000000},
        {"origin_country": "GE"},
        {"destination_country": "RU"},
        {"currency": "AMD"},
        {"origin": "  "},
        {"status": "ACTIVE"},
        {"carrier_id": str(uuid.uuid4())},
    ],
)
def test_route_input_rejects_ambiguous_money_time_and_unsupported_geography(changes):
    with pytest.raises(ValidationError):
        RouteCreate(**{**valid_input(), **changes})


@pytest.mark.parametrize(
    "changes", [{}, {"price": None}, {"origin": None}, {"status": "ACTIVE", "price": "100"}]
)
def test_patch_rejects_empty_null_or_mixed_transition(changes):
    with pytest.raises(ValidationError):
        RouteUpdate(**changes)
