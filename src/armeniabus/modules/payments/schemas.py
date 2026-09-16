import uuid
from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from armeniabus.modules.payments.models import PaymentStatus


class PaymentPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    booking_id: uuid.UUID
    status: PaymentStatus
    amount: Decimal
    currency: Literal["RUB"]
    confirmation_url: str | None
    review_reason: str | None
    created_at: datetime


class PayRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NotificationObject(BaseModel):
    id: uuid.UUID


class PaymentNotification(BaseModel):
    type: Literal["notification"]
    event: Literal["payment.succeeded", "payment.canceled", "payment.waiting_for_capture"]
    object: NotificationObject = Field(
        description="Only the ID is used; status is verified with YooKassa"
    )
