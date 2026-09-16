"""Booking holds, seat ownership and active-booking uniqueness.

Revision ID: 0006
Revises: 0005
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint("uq_routes_id_bus", "routes", ["id", "bus_id"])
    op.create_unique_constraint("uq_seats_id_bus", "seats", ["id", "bus_id"])
    op.create_table(
        "bookings",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("route_id", sa.Uuid(), nullable=False),
        sa.Column("seat_id", sa.Uuid(), nullable=False),
        sa.Column("bus_id", sa.Uuid(), nullable=False),
        sa.Column("passenger_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("held_until", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["route_id", "bus_id"], ["routes.id", "routes.bus_id"], name="fk_booking_route_bus"
        ),
        sa.ForeignKeyConstraint(
            ["seat_id", "bus_id"], ["seats.id", "seats.bus_id"], name="fk_booking_seat_bus"
        ),
        sa.CheckConstraint(
            "status IN ('HELD', 'PAID', 'EXPIRED', 'CANCELLED', 'COMPLETED')",
            name="ck_booking_status",
        ),
        sa.CheckConstraint("amount > 0", name="ck_booking_amount"),
        sa.CheckConstraint("currency = 'RUB'", name="ck_booking_currency"),
    )
    op.create_index(
        "uq_booking_active_seat",
        "bookings",
        ["route_id", "seat_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('HELD', 'PAID')"),
    )
    op.create_index(
        "ix_bookings_expiry",
        "bookings",
        ["held_until", "id"],
        postgresql_where=sa.text("status = 'HELD'"),
    )
    op.create_index(
        "ix_bookings_passenger_created", "bookings", ["passenger_id", "created_at", "id"]
    )
    op.create_index("ix_bookings_route_id", "bookings", ["route_id"])


def downgrade() -> None:
    op.drop_table("bookings")
    op.drop_constraint("uq_seats_id_bus", "seats", type_="unique")
    op.drop_constraint("uq_routes_id_bus", "routes", type_="unique")
