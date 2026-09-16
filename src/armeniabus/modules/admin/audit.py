import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.modules.admin.models import AuditLog


def record_audit(
    db: AsyncSession,
    actor_id: uuid.UUID | None,
    action: str,
    entity_type: str,
    entity_id: uuid.UUID,
    event_data: dict[str, Any] | None = None,
) -> None:
    """Persist with the caller's transaction; never put credentials in event_data."""
    db.add(
        AuditLog(
            actor_user_id=actor_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            event_data=event_data or {},
        )
    )
