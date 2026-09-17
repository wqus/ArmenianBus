import uuid
from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from armeniabus.infrastructure.db.base import Base


class PaymentStatus(StrEnum):
    PENDING = "PENDING"
    SUCCEEDED = "SUCCEEDED"
    CANCELED = "CANCELED"
    FAILED = "FAILED"


class Payment(Base):
    __tablename__ = "payments"
    __table_args__ = (
        Index("ix_payments_created", "created_at", "id"),
        Index(
            "ix_payments_review",
            "created_at",
            "id",
            postgresql_where=text("review_reason IS NOT NULL"),
        ),
        CheckConstraint(
            "status IN ('PENDING', 'SUCCEEDED', 'CANCELED', 'FAILED')", name="ck_payment_status"
        ),
        CheckConstraint("amount > 0 AND currency = 'RUB'", name="ck_payment_amount"),
        Index("uq_payment_client_key", "passenger_id", "client_key", unique=True),
        Index("ix_payment_reconcile", "next_check_at", postgresql_where=text("status = 'PENDING'")),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    booking_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("bookings.id"), unique=True, nullable=False
    )
    passenger_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), nullable=False)
    client_key: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    external_id: Mapped[str | None] = mapped_column(String(64), unique=True)
    shop_id: Mapped[str] = mapped_column(String(100), nullable=False)
    test_mode: Mapped[bool] = mapped_column(Boolean, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default=PaymentStatus.PENDING, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    request_payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    confirmation_url: Mapped[str | None] = mapped_column(String(2048))
    review_reason: Mapped[str | None] = mapped_column(String(100))
    last_error: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    next_check_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
