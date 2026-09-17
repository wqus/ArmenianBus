"""Worker health and bounded operational list indexes."""

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

INDEXES = (
    ("ix_users_created", "users", "created_at"),
    ("ix_audit_log_created", "audit_log", "created_at"),
    ("ix_payments_created", "payments", "created_at"),
    ("ix_bookings_created", "bookings", "created_at"),
    ("ix_notifications_created", "notifications", "created_at"),
    ("ix_routes_departure", "routes", "departure_at"),
)


def upgrade() -> None:
    op.create_table(
        "worker_heartbeats",
        sa.Column("name", sa.String(30), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_success_at", sa.DateTime(timezone=True)),
        sa.Column("last_error", sa.String(100)),
        sa.Column("last_count", sa.Integer(), nullable=False),
    )
    for name, table, field in INDEXES:
        op.create_index(name, table, [field, "id"])
    op.create_index(
        "ix_payments_review",
        "payments",
        ["created_at", "id"],
        postgresql_where=sa.text("review_reason IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_payments_review", "payments")
    for name, table, _ in reversed(INDEXES):
        op.drop_index(name, table)
    op.drop_table("worker_heartbeats")
