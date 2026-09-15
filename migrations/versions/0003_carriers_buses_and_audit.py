"""Add carrier profiles, buses, seats and audit history.

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "carrier_profiles",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False, unique=True),
        sa.Column("company_name", sa.String(200), nullable=False),
        sa.Column("phone", sa.String(16), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint("status IN ('PENDING', 'ACTIVE', 'BLOCKED')", name="ck_carrier_status"),
    )
    op.create_index("ix_carrier_profiles_status", "carrier_profiles", ["status"])
    op.create_table(
        "buses",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("carrier_id", sa.Uuid(), sa.ForeignKey("carrier_profiles.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("capacity", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("capacity BETWEEN 1 AND 100", name="ck_bus_capacity"),
    )
    op.create_index("ix_buses_carrier_id", "buses", ["carrier_id"])
    op.create_table(
        "seats",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("bus_id", sa.Uuid(), sa.ForeignKey("buses.id"), nullable=False),
        sa.Column("seat_number", sa.Integer(), nullable=False),
        sa.UniqueConstraint("bus_id", "seat_number", name="uq_seats_bus_number"),
        sa.CheckConstraint("seat_number BETWEEN 1 AND 100", name="ck_seat_number"),
    )
    op.create_table(
        "audit_log",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("actor_user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("action", sa.String(100), nullable=False),
        sa.Column("entity_type", sa.String(50), nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=False),
        sa.Column("metadata", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_audit_log_entity", "audit_log", ["entity_type", "entity_id"])


def downgrade() -> None:
    op.drop_index("ix_audit_log_entity", table_name="audit_log")
    op.drop_table("audit_log")
    op.drop_table("seats")
    op.drop_index("ix_buses_carrier_id", table_name="buses")
    op.drop_table("buses")
    op.drop_index("ix_carrier_profiles_status", table_name="carrier_profiles")
    op.drop_table("carrier_profiles")
