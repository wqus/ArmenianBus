import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from armeniabus.infrastructure.db.base import Base


class Bus(Base):
    __tablename__ = "buses"
    __table_args__ = (
        CheckConstraint("capacity BETWEEN 1 AND 100", name="ck_bus_capacity"),
        UniqueConstraint("id", "carrier_id", name="uq_buses_id_carrier"),
        Index("ix_buses_carrier_id", "carrier_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    carrier_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("carrier_profiles.id"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Seat(Base):
    __tablename__ = "seats"
    __table_args__ = (
        UniqueConstraint("bus_id", "seat_number", name="uq_seats_bus_number"),
        UniqueConstraint("id", "bus_id", name="uq_seats_id_bus"),
        CheckConstraint("seat_number BETWEEN 1 AND 100", name="ck_seat_number"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    bus_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("buses.id"), nullable=False)
    seat_number: Mapped[int] = mapped_column(Integer, nullable=False)
