import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from armeniabus.modules.bookings.cabinet import CabinetBooking
from armeniabus.modules.payments.models import PaymentStatus
from armeniabus.modules.routes.schemas import RoutePublic
from armeniabus.modules.users.models import UserStatus


class Page[T](BaseModel):
    items: list[T]
    limit: int
    offset: int


class WorkerHealth(BaseModel):
    name: Literal["holds", "payments", "notifications"]
    state: Literal["OK", "DISABLED", "MISSING", "STALE", "ERROR"]
    last_seen_at: datetime | None
    last_success_at: datetime | None
    last_error: str | None
    last_count: int | None


class QueueHealth(BaseModel):
    expired_holds: int
    payments_due: int
    payments_for_review: int
    open_refunds: int
    failed_notifications: int
    notifications_due: int
    oldest_notification_due_at: datetime | None


class OperationsHealth(BaseModel):
    checked_at: datetime
    workers: list[WorkerHealth]
    queues: QueueHealth


class ReasonInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class UserStatusInput(ReasonInput):
    status: UserStatus


class RefundRecordInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reference: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=100,
            pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
        ),
    ]


class NotificationRetryInput(ReasonInput):
    expected_generation: int = Field(ge=0, strict=True)


class PaymentVerifyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    external_id: uuid.UUID | None = None


class AdminPayment(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    booking_id: uuid.UUID
    passenger_id: uuid.UUID
    external_id: str | None
    status: PaymentStatus
    amount: Decimal
    currency: str
    test_mode: bool
    review_reason: str | None
    last_error: str | None
    created_at: datetime
    next_check_at: datetime


class AdminRoute(RoutePublic):
    archived_at: datetime | None


class AdminBooking(CabinetBooking):
    passenger_id: uuid.UUID


class NotificationPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    booking_id: uuid.UUID
    recipient_id: uuid.UUID
    event_key: str
    status: Literal["PENDING", "SENT", "FAILED"]
    attempts: int
    retry_generation: int
    next_attempt_at: datetime
    lease_until: datetime | None
    last_error: str | None
    sent_at: datetime | None
    created_at: datetime


class AuditPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    actor_user_id: uuid.UUID | None
    action: str
    entity_type: str
    entity_id: uuid.UUID
    event_data: dict[str, Any]
    created_at: datetime
