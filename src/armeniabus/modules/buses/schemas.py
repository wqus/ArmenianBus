import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from armeniabus.modules.buses.layouts import LAYOUTS, MODELS

BusName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class BusCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: BusName
    capacity: int = Field(ge=1, le=100, strict=True)
    layout_id: str | None = Field(default=None, max_length=64)
    vehicle_model_id: str | None = Field(default=None, max_length=64)
    layout_confirmed: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def validated_layout(self):
        if self.layout_id is not None:
            layout = LAYOUTS.get(self.layout_id)
            if layout is None or layout["capacity"] != self.capacity:
                raise ValueError("Choose a known layout matching passenger capacity")
            if not self.layout_confirmed:
                raise ValueError("Confirm the layout and seat numbering of the actual vehicle")
        elif self.vehicle_model_id is not None or self.layout_confirmed:
            raise ValueError("A vehicle model or confirmation requires a layout")
        if self.vehicle_model_id is not None and self.vehicle_model_id not in MODELS:
            raise ValueError("Unknown vehicle model")
        return self


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
    layout_id: str | None = None
    vehicle_model_id: str | None = None
    created_at: datetime


class BusPublic(BusSummary):
    seats: list[SeatPublic]


class BusPage(BaseModel):
    items: list[BusSummary]
    limit: int
    offset: int
