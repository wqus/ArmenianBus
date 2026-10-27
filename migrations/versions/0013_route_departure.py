"""Departure timezone and carrier-supplied boarding/drop-off addresses."""

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("routes", sa.Column("departure_timezone", sa.String(64), nullable=True))
    op.add_column("routes", sa.Column("boarding_address", sa.String(500), nullable=True))
    op.add_column("routes", sa.Column("dropoff_address", sa.String(500), nullable=True))


def downgrade() -> None:
    op.drop_column("routes", "dropoff_address")
    op.drop_column("routes", "boarding_address")
    op.drop_column("routes", "departure_timezone")
