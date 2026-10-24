import unicodedata
import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from armeniabus.modules.bookings.models import BookingStatus


class BookingCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    route_id: uuid.UUID
    seat_id: uuid.UUID
    passenger_first_name: str = Field(min_length=1, max_length=100)
    passenger_last_name: str = Field(min_length=1, max_length=100)
    passenger_phone: str = Field(min_length=9, max_length=40)

    @field_validator("passenger_first_name", "passenger_last_name")
    @classmethod
    def passenger_name(cls, value):
        value = unicodedata.normalize("NFC", value).strip()
        if not value or any(unicodedata.category(c).startswith("C") for c in value):
            raise ValueError("Use a name without control characters")
        if not any(c.isalpha() for c in value):
            raise ValueError("Use a passenger name")
        return value

    @field_validator("passenger_phone")
    @classmethod
    def international_phone(cls, value):
        value = value.strip()
        if any(c not in "+0123456789 ()-" for c in value):
            raise ValueError("Use an international phone number starting with +")
        value = "".join(c for c in value if c not in " ()-")
        if not value.startswith("+") or not value[1:].isascii() or not value[1:].isdigit():
            raise ValueError("Use an international phone number starting with +")
        if not 8 <= len(value[1:]) <= 15 or value[1] == "0":
            raise ValueError("Use 8 to 15 digits with a country code")
        return value


class BookingPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    route_id: uuid.UUID
    seat_id: uuid.UUID
    bus_id: uuid.UUID
    status: BookingStatus
    amount: Decimal
    currency: str
    held_until: datetime
    created_at: datetime
    # Existing bookings predate passenger collection. Never invent their identity.
    passenger_first_name: str | None = None
    passenger_last_name: str | None = None
    passenger_phone: str | None = None


class BookingPage(BaseModel):
    items: list[BookingPublic]
    limit: int
    offset: int
