import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict

from armeniabus.modules.bookings.models import BookingStatus


class BookingCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    route_id: uuid.UUID
    seat_id: uuid.UUID


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


class BookingPage(BaseModel):
    items: list[BookingPublic]
    limit: int
    offset: int
