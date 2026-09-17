import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Uuid, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from armeniabus.infrastructure.db.base import Base
from armeniabus.modules.admin.audit import record_audit
from armeniabus.modules.payments.models import Payment


class RefundCase(Base):
    __tablename__ = "refund_cases"
    __table_args__ = (
        CheckConstraint("status IN ('OPEN', 'REFUND_RECORDED')", name="ck_refund_case_status"),
        CheckConstraint(
            "(status = 'OPEN' AND resolved_at IS NULL AND resolved_by_user_id IS NULL "
            "AND resolution_reference IS NULL) OR (status = 'REFUND_RECORDED' "
            "AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL "
            "AND resolution_reference IS NOT NULL)",
            name="ck_refund_case_resolution",
        ),
        Index("ix_refund_cases_status_created", "status", "created_at", "id"),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    payment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("payments.id"), unique=True, nullable=False
    )
    reason: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(30), server_default="OPEN", nullable=False)
    resolution_reference: Mapped[str | None] = mapped_column(String(100), unique=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"))
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
    status = await db.scalar(select(RefundCase.status).where(RefundCase.payment_id == payment.id))
    if status == "OPEN":
        payment.review_reason = "REFUND_REQUIRED"
    if case_id:
        record_audit(db, actor_id, "refund.requested", "refund_case", case_id, {"reason": reason})
