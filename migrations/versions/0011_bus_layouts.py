"""Optional immutable layout identities; legacy seat numbers are preserved."""

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("buses", sa.Column("layout_id", sa.String(64), nullable=True))
    op.add_column("buses", sa.Column("vehicle_model_id", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("buses", "vehicle_model_id")
    op.drop_column("buses", "layout_id")
