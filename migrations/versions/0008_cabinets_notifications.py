"""Manual refund cases and durable notification outbox.

Revision ID: 0008
Revises: 0007
"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "refund_cases",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "payment_id", sa.Uuid(), sa.ForeignKey("payments.id"), unique=True, nullable=False
        ),
        sa.Column("reason", sa.String(100), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.execute("""INSERT INTO refund_cases (id, payment_id, reason)
        SELECT gen_random_uuid(), id, 'LEGACY_REFUND_REQUIRED' FROM payments
        WHERE status = 'SUCCEEDED' AND review_reason = 'REFUND_REQUIRED'""")
    op.create_table(
        "notifications",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("event_key", sa.String(150), unique=True, nullable=False),
        sa.Column("booking_id", sa.Uuid(), sa.ForeignKey("bookings.id"), nullable=False),
        sa.Column("recipient_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("recipient_email", sa.String(320), nullable=False),
        sa.Column("subject", sa.String(200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("lease_token", sa.Uuid()),
        sa.Column("last_error", sa.String(100)),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('PENDING', 'SENT', 'FAILED')", name="ck_notification_status"
        ),
        sa.CheckConstraint("attempts >= 0", name="ck_notification_attempts"),
    )
    op.create_index("ix_notifications_due", "notifications", ["status", "next_attempt_at"])


def downgrade() -> None:
    op.drop_table("notifications")
    op.drop_table("refund_cases")
