from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.modules.admin.audit import record_audit
from armeniabus.modules.bookings.models import Booking, BookingStatus


async def database_now(db: AsyncSession) -> datetime:
    # Read after acquiring locks: transaction start time may precede a long wait.
    return await db.scalar(select(func.clock_timestamp()))


def expire_booking(db: AsyncSession, booking: Booking, now: datetime) -> bool:
    if booking.status != BookingStatus.HELD or booking.held_until > now:
        return False
    booking.status = BookingStatus.EXPIRED
    record_audit(db, None, "booking.expired", "booking", booking.id)
    return True


async def expire_batch(db: AsyncSession, batch_size: int = 500) -> int:
    now = await database_now(db)
    rows = await db.scalars(
        select(Booking)
        .where(Booking.status == BookingStatus.HELD, Booking.held_until <= now)
        .order_by(Booking.held_until, Booking.id)
        .limit(batch_size)
        .with_for_update(skip_locked=True)
    )
    count = sum(expire_booking(db, row, now) for row in rows)
    await db.commit()
    return count
