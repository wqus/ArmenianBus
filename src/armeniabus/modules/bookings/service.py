import uuid
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.errors import ApiError
from armeniabus.modules.admin.audit import record_audit
from armeniabus.modules.bookings.lifecycle import database_now, expire_booking
from armeniabus.modules.bookings.models import Booking, BookingStatus
from armeniabus.modules.bookings.policy import paid_cancellation_allowed
from armeniabus.modules.bookings.schemas import BookingCreate, BookingPage, BookingPublic
from armeniabus.modules.buses.models import Bus, Seat
from armeniabus.modules.carriers.models import CarrierProfile, CarrierStatus
from armeniabus.modules.notifications.outbox import enqueue
from armeniabus.modules.payments.models import Payment, PaymentStatus
from armeniabus.modules.payments.refunds import request_refund
from armeniabus.modules.routes.models import Route, RouteStatus
from armeniabus.modules.users.models import User, UserStatus


def public_booking(booking: Booking, now: datetime) -> BookingPublic:
    result = BookingPublic.model_validate(booking)
    if booking.status == BookingStatus.HELD and booking.held_until <= now:
        result.status = BookingStatus.EXPIRED
    return result


async def create_booking(
    db: AsyncSession, user: User, data: BookingCreate, ttl_minutes: int
) -> Booking:
    # Same lock order as carrier mutations: profile -> route -> bus -> seat -> booking.
    carrier_id = await db.scalar(select(Route.carrier_id).where(Route.id == data.route_id))
    carrier = await db.scalar(
        select(CarrierProfile)
        .join(User, User.id == CarrierProfile.user_id)
        .where(
            CarrierProfile.id == carrier_id,
            CarrierProfile.status == CarrierStatus.ACTIVE,
            User.status == UserStatus.ACTIVE,
        )
        .with_for_update(of=CarrierProfile)
    )
    if carrier is None:
        raise ApiError(404, "ROUTE_NOT_FOUND", "Route not found")
    # Account blocking locks this profile; read account state again after any wait.
    if await db.scalar(select(User.status).where(User.id == carrier.user_id)) != UserStatus.ACTIVE:
        raise ApiError(404, "ROUTE_NOT_FOUND", "Route not found")
    route = await db.scalar(select(Route).where(Route.id == data.route_id).with_for_update())
    if route is None or route.status != RouteStatus.ACTIVE or route.archived_at is not None:
        raise ApiError(404, "ROUTE_NOT_FOUND", "Route not found")
    bus = await db.scalar(select(Bus).where(Bus.id == route.bus_id).with_for_update())
    if bus.archived_at is not None:
        raise ApiError(404, "ROUTE_NOT_FOUND", "Route not found")
    seat = await db.scalar(
        select(Seat).where(Seat.id == data.seat_id, Seat.bus_id == route.bus_id).with_for_update()
    )
    if seat is None:
        raise ApiError(404, "SEAT_NOT_FOUND", "Seat not found on this route")
    active = list(
        await db.scalars(
            select(Booking)
            .where(
                Booking.route_id == route.id,
                Booking.seat_id == seat.id,
                Booking.status.in_([BookingStatus.HELD, BookingStatus.PAID]),
            )
            .with_for_update()
        )
    )
    now = await database_now(db)
    if route.departure_at <= now:
        raise ApiError(409, "ROUTE_NOT_BOOKABLE", "Scheduled departure has been reached")
    for previous in active:
        if not expire_booking(db, previous, now):
            raise ApiError(409, "BOOKING_CONFLICT", "Seat is already held or paid")
    await db.flush()  # Release the partial unique index entry before inserting its successor.
    booking = Booking(
        route_id=route.id,
        seat_id=seat.id,
        bus_id=route.bus_id,
        passenger_id=user.id,
        passenger_first_name=data.passenger_first_name,
        passenger_last_name=data.passenger_last_name,
        passenger_phone=data.passenger_phone,
        amount=route.price,
        currency=route.currency,
        created_at=now,
        held_until=min(now + timedelta(minutes=ttl_minutes), route.departure_at),
    )
    db.add(booking)
    try:
        await db.flush()
        record_audit(db, user.id, "booking.created", "booking", booking.id)
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        # Only the known active-seat uniqueness violation is a booking conflict.
        if "uq_booking_active_seat" in str(exc.orig):
            raise ApiError(409, "BOOKING_CONFLICT", "Seat is already held or paid") from None
        raise
    return booking


async def own_booking(db: AsyncSession, user: User, booking_id: uuid.UUID) -> Booking:
    booking = await db.scalar(
        select(Booking).where(Booking.id == booking_id, Booking.passenger_id == user.id)
    )
    if booking is None:
        raise ApiError(404, "BOOKING_NOT_FOUND", "Booking not found")
    return booking


async def booking_details(db: AsyncSession, user: User, booking_id: uuid.UUID) -> BookingPublic:
    row = (
        await db.execute(
            select(Booking, func.statement_timestamp().label("read_at")).where(
                Booking.id == booking_id, Booking.passenger_id == user.id
            )
        )
    ).one_or_none()
    if row is None:
        raise ApiError(404, "BOOKING_NOT_FOUND", "Booking not found")
    return public_booking(row.Booking, row.read_at)


async def list_bookings(db: AsyncSession, user: User, limit: int, offset: int) -> BookingPage:
    rows = await db.execute(
        select(Booking, func.statement_timestamp().label("read_at"))
        .where(Booking.passenger_id == user.id)
        .order_by(Booking.created_at.desc(), Booking.id.desc())
        .limit(limit)
        .offset(offset)
    )
    return BookingPage(
        items=[public_booking(row.Booking, row.read_at) for row in rows], limit=limit, offset=offset
    )


async def cancel_booking(
    db: AsyncSession,
    user: User,
    booking_id: uuid.UUID,
    cutoff_hours: int = 24,
    *,
    hold_only: bool = False,
) -> None:
    booking = await own_booking(db, user, booking_id)
    route = await db.scalar(select(Route).where(Route.id == booking.route_id).with_for_update())
    booking = await db.scalar(
        select(Booking)
        .where(Booking.id == booking_id, Booking.passenger_id == user.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if booking.status in (BookingStatus.CANCELLED, BookingStatus.EXPIRED):
        return
    if hold_only and booking.status != BookingStatus.HELD:
        raise ApiError(409, "BOOKING_NOT_HELD", "Booking is no longer an unpaid hold")
    payment = None
    if booking.status == BookingStatus.PAID:
        payment = await db.scalar(
            select(Payment)
            .where(Payment.booking_id == booking.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    now = await database_now(db)
    if booking.status == BookingStatus.PAID:
        if not paid_cancellation_allowed(route.status, route.departure_at, now, cutoff_hours):
            raise ApiError(409, "CANCELLATION_CUTOFF", "Paid cancellation deadline has passed")
        if payment is None or payment.status != PaymentStatus.SUCCEEDED:
            raise ApiError(
                409, "BOOKING_NOT_CANCELLABLE", "Verified payment is required for cancellation"
            )
        booking.status = BookingStatus.CANCELLED
        await request_refund(db, payment, "PASSENGER_CANCELLED", user.id)
        await enqueue(db, booking, "cancelled")
        record_audit(
            db,
            user.id,
            "booking.cancelled",
            "booking",
            booking.id,
            {"reason": "passenger", "refund_required": True},
        )
        await db.commit()
        return
    if not expire_booking(db, booking, now):
        if booking.status != BookingStatus.HELD:
            raise ApiError(409, "BOOKING_NOT_CANCELLABLE", "Booking can no longer be cancelled")
        booking.status = BookingStatus.CANCELLED
        await enqueue(db, booking, "cancelled")
        record_audit(db, user.id, "booking.cancelled", "booking", booking.id)
    await db.commit()
