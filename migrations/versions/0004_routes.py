"""Add journeys with exact prices and carrier/bus ownership constraints.

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint("uq_buses_id_carrier", "buses", ["id", "carrier_id"])
    op.create_table(
        "routes",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("carrier_id", sa.Uuid(), sa.ForeignKey("carrier_profiles.id"), nullable=False),
        sa.Column("bus_id", sa.Uuid(), nullable=False),
        sa.Column("origin_country", sa.String(2), nullable=False),
        sa.Column("destination_country", sa.String(2), nullable=False),
        sa.Column("origin", sa.String(200), nullable=False),
        sa.Column("destination", sa.String(200), nullable=False),
        sa.Column("departure_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("price", sa.Numeric(12, 2), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.ForeignKeyConstraint(
            ["bus_id", "carrier_id"], ["buses.id", "buses.carrier_id"], name="fk_routes_owned_bus"
        ),
        sa.CheckConstraint(
            "(origin_country = 'RU' AND destination_country = 'AM') OR "
            "(origin_country = 'AM' AND destination_country = 'RU')",
            name="ck_routes_geography",
        ),
        sa.CheckConstraint("price > 0", name="ck_routes_price"),
        sa.CheckConstraint("currency = 'RUB'", name="ck_routes_currency"),
        sa.CheckConstraint(
            "status IN ('DRAFT', 'ACTIVE', 'DEPARTED', 'COMPLETED', 'CANCELLED')",
            name="ck_routes_status",
        ),
    )
    op.create_index("ix_routes_search", "routes", ["origin", "destination", "departure_at"])
    op.create_index("ix_routes_carrier_id", "routes", ["carrier_id"])
    op.create_index("ix_routes_bus_id", "routes", ["bus_id"])


def downgrade() -> None:
    op.drop_index("ix_routes_bus_id", table_name="routes")
    op.drop_index("ix_routes_carrier_id", table_name="routes")
    op.drop_index("ix_routes_search", table_name="routes")
    op.drop_table("routes")
    op.drop_constraint("uq_buses_id_carrier", "buses", type_="unique")
