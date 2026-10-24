"""Collect passenger contact details without fabricating legacy identities."""

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bookings", sa.Column("passenger_first_name", sa.String(100), nullable=True))
    op.add_column("bookings", sa.Column("passenger_last_name", sa.String(100), nullable=True))
    op.add_column("bookings", sa.Column("passenger_phone", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("bookings", "passenger_phone")
    op.drop_column("bookings", "passenger_last_name")
    op.drop_column("bookings", "passenger_first_name")
