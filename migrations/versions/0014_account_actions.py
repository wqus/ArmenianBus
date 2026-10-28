"""One-time account links, private mail queue, and access-token revocation version."""

import sqlalchemy as sa
from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("auth_version", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column(
        "users", sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_table(
        "auth_actions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("purpose", sa.String(20), nullable=False),
        sa.Column("recipient_email", sa.String(320), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("mail_status", sa.String(10), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_token", sa.Uuid(), nullable=True),
        sa.Column("last_error", sa.String(100), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "purpose IN ('RESET', 'VERIFY', 'PASSWORD_CHANGED')", name="ck_auth_action_purpose"
        ),
        sa.CheckConstraint(
            "mail_status IN ('PENDING', 'SENT', 'FAILED')", name="ck_auth_action_mail_status"
        ),
    )
    op.create_index("ix_auth_actions_user_created", "auth_actions", ["user_id", "created_at"])
    op.create_index("ix_auth_actions_delivery", "auth_actions", ["mail_status", "next_attempt_at"])


def downgrade() -> None:
    op.drop_table("auth_actions")
    op.drop_column("users", "email_verified_at")
    op.drop_column("users", "auth_version")
