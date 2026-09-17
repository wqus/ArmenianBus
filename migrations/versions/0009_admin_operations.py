"""Auditable manual refund outcomes and notification retry generations."""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "refund_cases", sa.Column("status", sa.String(30), server_default="OPEN", nullable=False)
    )
    op.add_column("refund_cases", sa.Column("resolution_reference", sa.String(100)))
    op.add_column("refund_cases", sa.Column("resolved_at", sa.DateTime(timezone=True)))
    op.add_column("refund_cases", sa.Column("resolved_by_user_id", sa.Uuid()))
    op.create_foreign_key(
        "fk_refund_cases_resolved_by", "refund_cases", "users", ["resolved_by_user_id"], ["id"]
    )
    op.create_unique_constraint(
        "uq_refund_cases_resolution_reference", "refund_cases", ["resolution_reference"]
    )
    op.create_check_constraint(
        "ck_refund_case_status", "refund_cases", "status IN ('OPEN', 'REFUND_RECORDED')"
    )
    op.create_check_constraint(
        "ck_refund_case_resolution",
        "refund_cases",
        "(status = 'OPEN' AND resolved_at IS NULL AND resolved_by_user_id IS NULL "
        "AND resolution_reference IS NULL) OR (status = 'REFUND_RECORDED' "
        "AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL "
        "AND resolution_reference IS NOT NULL)",
    )
    op.create_index(
        "ix_refund_cases_status_created", "refund_cases", ["status", "created_at", "id"]
    )
    op.add_column(
        "notifications",
        sa.Column("retry_generation", sa.Integer(), server_default="0", nullable=False),
    )
    op.create_check_constraint(
        "ck_notification_retry_generation", "notifications", "retry_generation >= 0"
    )


def downgrade() -> None:
    op.drop_constraint("ck_notification_retry_generation", "notifications")
    op.drop_column("notifications", "retry_generation")
    op.drop_index("ix_refund_cases_status_created", "refund_cases")
    op.drop_constraint("ck_refund_case_resolution", "refund_cases")
    op.drop_constraint("ck_refund_case_status", "refund_cases")
    op.drop_constraint("uq_refund_cases_resolution_reference", "refund_cases")
    op.drop_constraint("fk_refund_cases_resolved_by", "refund_cases")
    for column in ("resolved_by_user_id", "resolved_at", "resolution_reference", "status"):
        op.drop_column("refund_cases", column)
