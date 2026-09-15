import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator

from armeniabus.modules.carriers.models import CarrierStatus

CompanyName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
PhoneNumber = Annotated[str, StringConstraints(pattern=r"^\+[1-9][0-9]{7,14}$")]


class CarrierInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    company_name: CompanyName
    phone: PhoneNumber


class CarrierPublic(CarrierInput):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    id: uuid.UUID
    user_id: uuid.UUID
    status: CarrierStatus
    created_at: datetime


class CarrierUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    company_name: CompanyName | None = None
    phone: PhoneNumber | None = None

    @model_validator(mode="after")
    def require_changes(self):
        if not self.model_fields_set or any(
            getattr(self, field) is None for field in self.model_fields_set
        ):
            raise ValueError("Provide at least one non-null profile field")
        return self


class CarrierPage(BaseModel):
    items: list[CarrierPublic]
    limit: int
    offset: int


class CarrierStatusInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal[CarrierStatus.ACTIVE, CarrierStatus.BLOCKED]
