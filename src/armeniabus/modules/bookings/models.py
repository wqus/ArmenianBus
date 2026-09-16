import uuid
from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Numeric,
    String,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from armeniabus.infrastructure.db.base import Base


class BookingStatus(StrEnum):
    HELD = "HELD"
    PAID = "PAID"
    EXPIRED = "EXPIRED"
    CANCELLED = "CANCELLED"
    COMPLETED = "COMPLETED"


class Booking(Base):
    __tablename__ = "bookings"
    __table_args__ = (
        ForeignKeyConstraint(
            ["route_id", "bus_id"], ["routes.id", "routes.bus_id"], name="fk_booking_route_bus"
        ),
        ForeignKeyConstraint(
            ["seat_id", "bus_id"], ["seats.id", "seats.bus_id"], name="fk_booking_seat_bus"
        ),
        CheckConstraint(
            "status IN ('HELD', 'PAID', 'EXPIRED', 'CANCELLED', 'COMPLETED')",
            name="ck_booking_status",
        ),
        CheckConstraint("amount > 0", name="ck_booking_amount"),
        CheckConstraint("currency = 'RUB'", name="ck_booking_currency"),
        Index(
            "uq_booking_active_seat",
            "route_id",
            "seat_id",
            unique=True,
            postgresql_where=text("status IN ('HELD', 'PAID')"),
        ),
        Index("ix_bookings_expiry", "held_until", "id", postgresql_where=text("status = 'HELD'")),
        Index("ix_bookings_passenger_created", "passenger_id", "created_at", "id"),
        Index("ix_bookings_route_id", "route_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    route_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    seat_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    bus_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    passenger_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default=BookingStatus.HELD, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="RUB", nullable=False)
    held_until: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
