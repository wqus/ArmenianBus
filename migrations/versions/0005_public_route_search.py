"""Index published trips for case-insensitive direction and UTC date search.

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_routes_public_search",
        "routes",
        [sa.text("lower(origin)"), sa.text("lower(destination)"), "departure_at", "id"],
        postgresql_where=sa.text("status = 'ACTIVE' AND archived_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_routes_public_search", table_name="routes")
