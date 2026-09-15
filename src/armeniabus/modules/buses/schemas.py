import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

BusName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class BusCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: BusName
    capacity: int = Field(ge=1, le=100, strict=True)


class BusUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: BusName


class SeatPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    seat_number: int


class BusSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    carrier_id: uuid.UUID
    name: str
    capacity: int
    created_at: datetime


class BusPublic(BusSummary):
    seats: list[SeatPublic]


class BusPage(BaseModel):
    items: list[BusSummary]
    limit: int
    offset: int
