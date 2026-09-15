import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from armeniabus.modules.users.models import UserRole, UserStatus


class RegisterInput(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12, max_length=128)
    role: Literal[UserRole.PASSENGER, UserRole.CARRIER]


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
