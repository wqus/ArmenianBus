import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Uuid, func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from armeniabus.infrastructure.db.base import Base
from armeniabus.modules.admin.audit import record_audit
from armeniabus.modules.payments.models import Payment


class RefundCase(Base):
    __tablename__ = "refund_cases"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    payment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("payments.id"), unique=True, nullable=False
    )
    reason: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


async def request_refund(db: AsyncSession, payment: Payment, reason: str, actor_id=None) -> None:
    """Create a manual work item, never claim that money has been returned."""
    case_id = await db.scalar(
        insert(RefundCase)
        .values(payment_id=payment.id, reason=reason)
        .on_conflict_do_nothing(index_elements=[RefundCase.payment_id])
        .returning(RefundCase.id)
    )
    payment.review_reason = "REFUND_REQUIRED"
    if case_id:
        record_audit(db, actor_id, "refund.requested", "refund_case", case_id, {"reason": reason})
