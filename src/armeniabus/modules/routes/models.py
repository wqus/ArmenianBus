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
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from armeniabus.infrastructure.db.base import Base


class RouteStatus(StrEnum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    DEPARTED = "DEPARTED"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class Route(Base):
    __tablename__ = "routes"
    __table_args__ = (
        UniqueConstraint("id", "bus_id", name="uq_routes_id_bus"),
        ForeignKeyConstraint(
            ["bus_id", "carrier_id"], ["buses.id", "buses.carrier_id"], name="fk_routes_owned_bus"
        ),
        CheckConstraint(
            "(origin_country = 'RU' AND destination_country = 'AM') OR "
            "(origin_country = 'AM' AND destination_country = 'RU')",
            name="ck_routes_geography",
        ),
        CheckConstraint("price > 0", name="ck_routes_price"),
        CheckConstraint("currency = 'RUB'", name="ck_routes_currency"),
        CheckConstraint(
            "status IN ('DRAFT', 'ACTIVE', 'DEPARTED', 'COMPLETED', 'CANCELLED')",
            name="ck_routes_status",
        ),
        Index("ix_routes_search", "origin", "destination", "departure_at"),
        Index(
            "ix_routes_public_search",
            text("lower(origin)"),
            text("lower(destination)"),
            "departure_at",
            "id",
            postgresql_where=text("status = 'ACTIVE' AND archived_at IS NULL"),
        ),
        Index("ix_routes_carrier_id", "carrier_id"),
        Index("ix_routes_bus_id", "bus_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    carrier_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("carrier_profiles.id"), nullable=False
    )
    bus_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    origin_country: Mapped[str] = mapped_column(String(2), nullable=False)
    destination_country: Mapped[str] = mapped_column(String(2), nullable=False)
    origin: Mapped[str] = mapped_column(String(200), nullable=False)
    destination: Mapped[str] = mapped_column(String(200), nullable=False)
    departure_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="RUB", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default=RouteStatus.DRAFT, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
