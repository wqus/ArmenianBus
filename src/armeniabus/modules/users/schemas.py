import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from src.armeniabus.modules.carriers.schemas import CompanyName, PhoneNumber
from src.armeniabus.modules.users.models import UserRole, UserStatus


class RegisterInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    password: str = Field(min_length=12, max_length=128)
    role: Literal[UserRole.PASSENGER, UserRole.CARRIER]
    company_name: CompanyName | None = None
    phone: PhoneNumber | None = None

    @model_validator(mode="after")
    def validate_carrier_fields(self):
        if self.role == UserRole.CARRIER and (self.company_name is None or self.phone is None):
            raise ValueError("Carrier registration requires company_name and phone")
        if self.role == UserRole.PASSENGER and (
            self.company_name is not None or self.phone is not None
        ):
            raise ValueError("Carrier fields are only allowed for CARRIER registration")
        return self


class LoginInput(BaseModel):
    email: EmailStr
    password: str


class RefreshInput(BaseModel):
    refresh_token: str = Field(min_length=32)


class LogoutInput(RefreshInput):
    pass


class UserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: EmailStr
    role: UserRole
    status: UserStatus
    created_at: datetime


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: Literal["Bearer"] = "Bearer"
    expires_in: int
