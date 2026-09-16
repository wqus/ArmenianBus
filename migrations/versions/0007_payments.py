"""Durable idempotent payment intents and reconciliation.

Revision ID: 0007
Revises: 0006
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "payments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "booking_id", sa.Uuid(), sa.ForeignKey("bookings.id"), unique=True, nullable=False
        ),
        sa.Column("passenger_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("client_key", sa.Uuid(), nullable=False),
        sa.Column("external_id", sa.String(64), unique=True),
        sa.Column("shop_id", sa.String(100), nullable=False),
        sa.Column("test_mode", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("request_payload", postgresql.JSONB(), nullable=False),
        sa.Column("confirmation_url", sa.String(2048)),
        sa.Column("review_reason", sa.String(100)),
        sa.Column("last_error", sa.String(100)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "next_check_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('PENDING', 'SUCCEEDED', 'CANCELED', 'FAILED')", name="ck_payment_status"
        ),
        sa.CheckConstraint("amount > 0 AND currency = 'RUB'", name="ck_payment_amount"),
    )
    op.create_index(
        "uq_payment_client_key", "payments", ["passenger_id", "client_key"], unique=True
    )
    op.create_index(
        "ix_payment_reconcile",
        "payments",
        ["next_check_at"],
        postgresql_where=sa.text("status = 'PENDING'"),
    )


def downgrade() -> None:
    op.drop_table("payments")
