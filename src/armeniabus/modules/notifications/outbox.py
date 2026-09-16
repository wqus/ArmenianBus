from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.modules.bookings.models import Booking
from armeniabus.modules.buses.models import Seat
from armeniabus.modules.notifications.models import Notification
from armeniabus.modules.routes.models import Route
from armeniabus.modules.users.models import User

SUBJECTS = {
    "paid": "ArmeniaBus: оплата поездки подтверждена",
    "cancelled": "ArmeniaBus: бронирование отменено",
    "refund_required": "ArmeniaBus: платёж требует проверки и возврата",
}


async def enqueue(db: AsyncSession, booking: Booking, event: str) -> None:
    route = await db.get(Route, booking.route_id)
    seat_number = await db.scalar(select(Seat.seat_number).where(Seat.id == booking.seat_id))
    recipient = await db.scalar(select(User.email).where(User.id == booking.passenger_id))
    body = (
        f"{SUBJECTS[event]}\nБронирование: {booking.id}\n"
        f"{route.origin} → {route.destination}\n"
        f"Отправление (UTC): {route.departure_at.isoformat()}\n"
        f"Место: {seat_number}\nСумма: {booking.amount} {booking.currency}\n"
    )
    if event in {"cancelled", "refund_required"}:
        body += (
            "Это уведомление не подтверждает возврат денег. "
            "Возврат оплаченного билета обрабатывается отдельно.\n"
        )
    await db.execute(
        insert(Notification)
        .values(
            event_key=f"booking:{booking.id}:{event}",
            booking_id=booking.id,
            recipient_id=booking.passenger_id,
            recipient_email=recipient,
            subject=SUBJECTS[event],
            body=body,
        )
        .on_conflict_do_nothing(index_elements=[Notification.event_key])
    )
