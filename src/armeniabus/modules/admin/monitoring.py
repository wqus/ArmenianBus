from datetime import datetime, timedelta

from sqlalchemy import Boolean, DateTime, Integer, String, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Mapped, mapped_column

from armeniabus.infrastructure.db.base import Base
from armeniabus.modules.bookings.models import Booking
from armeniabus.modules.notifications.models import Notification
from armeniabus.modules.payments.models import Payment
from armeniabus.modules.payments.refunds import RefundCase

WORKERS = ("holds", "payments", "notifications")


class WorkerHeartbeat(Base):
    __tablename__ = "worker_heartbeats"
    name: Mapped[str] = mapped_column(String(30), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(100))
    last_count: Mapped[int] = mapped_column(Integer, nullable=False)


async def heartbeat(sessions, name, *, enabled=True, count=0, error=None):
    async with sessions() as db:
        now = await db.scalar(select(func.clock_timestamp()))
        values = dict(
            name=name, enabled=enabled, last_seen_at=now, last_count=count, last_error=error
        )
        if error is None:
            values["last_success_at"] = now
        await db.execute(
            insert(WorkerHeartbeat)
            .values(**values)
            .on_conflict_do_update(
                index_elements=[WorkerHeartbeat.name],
                set_={key: value for key, value in values.items() if key != "name"},
            )
        )
        await db.commit()


def worker_state(row, now, stale_seconds):
    if row is None:
        return "MISSING"
    if row.last_seen_at < now - timedelta(seconds=stale_seconds):
        return "STALE"
    if row.last_error:
        return "ERROR"
    return "OK" if row.enabled else "DISABLED"


async def snapshot(db, stale_seconds):
    now = await db.scalar(select(func.statement_timestamp()))
    rows = {row.name: row for row in await db.scalars(select(WorkerHeartbeat))}
    counters = (
        (
            await db.execute(
                select(
                    select(func.count())
                    .select_from(Booking)
                    .where(Booking.status == "HELD", Booking.held_until <= now)
                    .scalar_subquery()
                    .label("expired_holds"),
                    select(func.count())
                    .select_from(Payment)
                    .where(
                        Payment.status == "PENDING",
                        Payment.review_reason.is_(None),
                        Payment.next_check_at <= now,
                    )
                    .scalar_subquery()
                    .label("payments_due"),
                    select(func.count())
                    .select_from(Payment)
                    .where(Payment.review_reason.is_not(None))
                    .scalar_subquery()
                    .label("payments_for_review"),
                    select(func.count())
                    .select_from(RefundCase)
                    .where(RefundCase.status == "OPEN")
                    .scalar_subquery()
                    .label("open_refunds"),
                    select(func.count())
                    .select_from(Notification)
                    .where(Notification.status == "FAILED")
                    .scalar_subquery()
                    .label("failed_notifications"),
                    select(func.count())
                    .select_from(Notification)
                    .where(Notification.status == "PENDING", Notification.next_attempt_at <= now)
                    .scalar_subquery()
                    .label("notifications_due"),
                    select(func.min(Notification.next_attempt_at))
                    .where(Notification.status == "PENDING", Notification.next_attempt_at <= now)
                    .scalar_subquery()
                    .label("oldest_notification_due_at"),
                )
            )
        )
        .mappings()
        .one()
    )
    workers = [
        {
            "name": name,
            "state": worker_state(rows.get(name), now, stale_seconds),
            "last_seen_at": rows[name].last_seen_at if name in rows else None,
            "last_success_at": rows[name].last_success_at if name in rows else None,
            "last_error": rows[name].last_error if name in rows else None,
            "last_count": rows[name].last_count if name in rows else None,
        }
        for name in WORKERS
    ]
    return {"checked_at": now, "workers": workers, "queues": dict(counters)}
