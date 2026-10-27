import unicodedata
import uuid
from datetime import UTC, datetime
from datetime import date as CalendarDate
from decimal import Decimal
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from armeniabus.modules.cities.catalog import canonical_name, departure_zone, resolve
from armeniabus.modules.routes.models import RouteStatus

Country = Literal["RU", "AM"]
PlaceName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Price = Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=2)]


class RouteFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("boarding_address", "dropoff_address", check_fields=False)
    @classmethod
    def valid_address(cls, value):
        if value is not None:
            value = value.strip()
            if len(value) < 5 or any(unicodedata.category(c).startswith("C") for c in value):
                raise ValueError("Use a boarding or drop-off address without control characters")
        return value

    @field_validator("departure_timezone", check_fields=False)
    @classmethod
    def valid_zone(cls, value):
        if value is not None:
            if value != "UTC" and not value.startswith(("Europe/", "Asia/")):
                raise ValueError("Use a timezone for the departure city")
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError):
                raise ValueError("Use an IANA timezone") from None
        return value

    @field_validator("price", mode="before", check_fields=False)
    @classmethod
    def exact_price(cls, value):
        if isinstance(value, (float, bool)):
            raise ValueError("Send price as a decimal string, for example '4500.50'")
        return value

    @field_validator("price", check_fields=False)
    @classmethod
    def monetary_scale(cls, value):
        return value.quantize(Decimal("0.01")) if value is not None else None

    @field_validator("departure_at", mode="before", check_fields=False)
    @classmethod
    def iso_datetime(cls, value):
        if value is not None and not isinstance(value, (str, datetime)):
            raise ValueError("Use an ISO 8601 datetime with timezone")
        return value

    @field_validator("departure_at", check_fields=False)
    @classmethod
    def utc_datetime(cls, value):
        return value.astimezone(UTC) if value is not None else None


class RouteCreate(RouteFields):
    bus_id: uuid.UUID
    origin_country: Country
    destination_country: Country
    origin: PlaceName
    destination: PlaceName
    departure_at: AwareDatetime
    departure_timezone: str | None = Field(default=None, max_length=64)
    boarding_address: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=5, max_length=500)
    ]
    dropoff_address: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=5, max_length=500)
    ]
    price: Price
    currency: Literal["RUB"] = "RUB"

    @model_validator(mode="after")
    def cross_border_only(self):
        if self.origin_country == self.destination_country:
            raise ValueError("Only cross-border RU ↔ AM routes are supported")
        self.origin = canonical_name(self.origin, self.origin_country)
        self.destination = canonical_name(self.destination, self.destination_country)
        self.departure_timezone = departure_zone(
            self.origin, self.origin_country, self.departure_timezone
        )
        return self


class RouteUpdate(RouteFields):
    bus_id: uuid.UUID | None = None
    origin_country: Country | None = None
    destination_country: Country | None = None
    origin: PlaceName | None = None
    destination: PlaceName | None = None
    departure_at: AwareDatetime | None = None
    departure_timezone: str | None = Field(default=None, max_length=64)
    boarding_address: str | None = Field(default=None, max_length=500)
    dropoff_address: str | None = Field(default=None, max_length=500)
    price: Price | None = None
    status: RouteStatus | None = None

    @model_validator(mode="after")
    def valid_patch(self):
        fields = self.model_fields_set
        if not fields or any(getattr(self, field) is None for field in fields):
            raise ValueError("Provide at least one non-null route field")
        if "status" in fields and len(fields) != 1:
            raise ValueError("Change status separately from route details")
        return self


class RoutePublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    carrier_id: uuid.UUID
    bus_id: uuid.UUID
    origin_country: Country
    destination_country: Country
    origin: str
    destination: str
    departure_at: datetime
    departure_timezone: str | None = None
    boarding_address: str | None = None
    dropoff_address: str | None = None
    price: Decimal
    currency: Literal["RUB"]
    status: RouteStatus
    created_at: datetime

    @model_validator(mode="after")
    def legacy_timezone(self):
        self.departure_timezone = self.departure_timezone or departure_zone(
            self.origin, self.origin_country
        )
        return self


class RoutePage(BaseModel):
    items: list[RoutePublic]
    limit: int
    offset: int


class RouteSearch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    origin: PlaceName
    destination: PlaceName
    date: CalendarDate = Field(
        le=CalendarDate(9999, 12, 30), description="Departure calendar date in UTC"
    )
    limit: int = Field(default=20, ge=1, le=100)
    offset: int = Field(default=0, ge=0, le=10000)
    date_basis: Literal["utc", "local"] = "utc"

    @field_validator("origin", "destination")
    @classmethod
    def unambiguous_city(cls, value):
        resolve(value)
        return value


class SearchRoute(RoutePublic):
    company_name: str
    bus_name: str
    capacity: int
    free_seats: int


class SearchPage(BaseModel):
    items: list[SearchRoute]
    limit: int
    offset: int


class AvailableSeat(BaseModel):
    id: uuid.UUID
    seat_number: int
    status: Literal["FREE", "HELD", "PAID"]


class RouteSeats(BaseModel):
    route_id: uuid.UUID
    bus_id: uuid.UUID
    layout_id: str | None = None
    free_seats: int
    seats: list[AvailableSeat]
