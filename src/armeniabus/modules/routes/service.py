import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.errors import ApiError
from armeniabus.modules.admin.audit import record_audit
from armeniabus.modules.bookings.lifecycle import database_now, expire_booking
from armeniabus.modules.bookings.models import Booking, BookingStatus
from armeniabus.modules.buses.models import Bus
from armeniabus.modules.carriers.service import own_profile
from armeniabus.modules.notifications.outbox import enqueue
from armeniabus.modules.payments.models import Payment, PaymentStatus
from armeniabus.modules.payments.refunds import request_refund
from armeniabus.modules.routes.models import Route, RouteStatus
from armeniabus.modules.routes.schemas import RouteCreate, RoutePage, RoutePublic, RouteUpdate
from armeniabus.modules.users.models import User


async def available_bus(db: AsyncSession, carrier_id: uuid.UUID, bus_id: uuid.UUID) -> Bus:
    bus = await db.scalar(
        select(Bus)
        .where(Bus.id == bus_id, Bus.carrier_id == carrier_id, Bus.archived_at.is_(None))
        .with_for_update()
    )
    if bus is None:
        raise ApiError(404, "BUS_NOT_FOUND", "Bus not found")
    return bus


async def own_route(
    db: AsyncSession, user: User, route_id: uuid.UUID, *, lock=False, include_archived=False
) -> Route:
    profile = await own_profile(db, user.id, active=True, lock=lock)
    query = select(Route).where(Route.id == route_id, Route.carrier_id == profile.id)
    if not include_archived:
        query = query.where(Route.archived_at.is_(None))
    if lock:
        query = query.with_for_update()
    route = await db.scalar(query)
    if route is None:
        raise ApiError(404, "ROUTE_NOT_FOUND", "Route not found")
    return route


async def create_route(db: AsyncSession, user: User, data: RouteCreate) -> Route:
    profile = await own_profile(db, user.id, active=True, lock=True)
    await available_bus(db, profile.id, data.bus_id)
    if data.departure_at <= datetime.now(UTC):
        raise ApiError(422, "DEPARTURE_IN_PAST", "Departure must be in the future")
    route = Route(carrier_id=profile.id, **data.model_dump())
    db.add(route)
    await db.flush()
    record_audit(db, user.id, "route.created", "route", route.id)
    await db.commit()
    return route


async def list_routes(
    db: AsyncSession, user: User, limit: int, offset: int, status: RouteStatus | None
) -> RoutePage:
    profile = await own_profile(db, user.id, active=True)
    query = select(Route).where(Route.carrier_id == profile.id, Route.archived_at.is_(None))
    if status is not None:
        query = query.where(Route.status == status)
    rows = await db.scalars(
        query.order_by(Route.departure_at, Route.id).limit(limit).offset(offset)
    )
    return RoutePage(
        items=[RoutePublic.model_validate(route) for route in rows], limit=limit, offset=offset
    )


async def transition(db: AsyncSession, user: User, route: Route, target: RouteStatus) -> Route:
    previous = RouteStatus(route.status)
    if previous == target:
        return route
    allowed = {
        RouteStatus.DRAFT: {RouteStatus.ACTIVE},
        RouteStatus.ACTIVE: {RouteStatus.DEPARTED, RouteStatus.CANCELLED},
        RouteStatus.DEPARTED: {RouteStatus.COMPLETED},
        RouteStatus.COMPLETED: set(),
        RouteStatus.CANCELLED: set(),
    }
    if target not in allowed[previous]:
        raise ApiError(409, "INVALID_ROUTE_TRANSITION", "Route status transition is not allowed")
    now = await database_now(db)
    if target == RouteStatus.ACTIVE:
        await available_bus(db, route.carrier_id, route.bus_id)
        if route.departure_at <= now:
            raise ApiError(409, "DEPARTURE_IN_PAST", "Cannot publish a departed route")
    if target == RouteStatus.DEPARTED and route.departure_at > now:
        raise ApiError(409, "DEPARTURE_NOT_REACHED", "Scheduled departure has not been reached")
    if target in (RouteStatus.CANCELLED, RouteStatus.DEPARTED, RouteStatus.COMPLETED):
        bookings = list(
            await db.scalars(
                select(Booking)
                .where(
                    Booking.route_id == route.id,
                    Booking.status.in_([BookingStatus.HELD, BookingStatus.PAID]),
                )
                .order_by(Booking.id)
                .with_for_update()
            )
        )
        now = await database_now(db)
        for booking in bookings:
            if expire_booking(db, booking, now):
                continue
            if booking.status == BookingStatus.HELD and target == RouteStatus.CANCELLED:
                booking.status = BookingStatus.CANCELLED
                record_audit(
                    db,
                    user.id,
                    "booking.cancelled",
                    "booking",
                    booking.id,
                    {"reason": "route_cancelled"},
                )
                await enqueue(db, booking, "cancelled")
            elif booking.status == BookingStatus.PAID and target == RouteStatus.CANCELLED:
                payment = await db.scalar(
                    select(Payment)
                    .where(Payment.booking_id == booking.id)
                    .with_for_update()
                    .execution_options(populate_existing=True)
                )
                if payment is None or payment.status != PaymentStatus.SUCCEEDED:
                    raise ApiError(
                        409,
                        "ROUTE_HAS_PAID_BOOKINGS",
                        "Verified payments are required for operational cancellation",
                    )
                booking.status = BookingStatus.CANCELLED
                await request_refund(db, payment, "ROUTE_CANCELLED", user.id)
                await enqueue(db, booking, "cancelled")
                record_audit(
                    db,
                    user.id,
                    "booking.cancelled",
                    "booking",
                    booking.id,
                    {"reason": "route_cancelled", "refund_required": True},
                )
            elif booking.status == BookingStatus.PAID and target == RouteStatus.COMPLETED:
                booking.status = BookingStatus.COMPLETED
                record_audit(db, user.id, "booking.completed", "booking", booking.id)
    route.status = target
    record_audit(
        db, user.id, "route.status_changed", "route", route.id, {"from": previous, "to": target}
    )
    await db.commit()
    return route


async def update_route(
    db: AsyncSession, user: User, route_id: uuid.UUID, data: RouteUpdate
) -> Route:
    route = await own_route(db, user, route_id, lock=True)
    if data.status is not None:
        return await transition(db, user, route, data.status)
    if route.status not in (RouteStatus.DRAFT, RouteStatus.ACTIVE):
        raise ApiError(409, "ROUTE_NOT_EDITABLE", "Route details can no longer be edited")
    if route.departure_at <= datetime.now(UTC):
        raise ApiError(409, "ROUTE_NOT_EDITABLE", "Scheduled departure has been reached")
    changes = data.model_dump(exclude_unset=True)
    origin = changes.get("origin_country", route.origin_country)
    destination = changes.get("destination_country", route.destination_country)
    if origin == destination:
        raise ApiError(
            422, "UNSUPPORTED_DIRECTION", "Only cross-border RU ↔ AM routes are supported"
        )
    if "departure_at" in changes and changes["departure_at"] <= datetime.now(UTC):
        raise ApiError(422, "DEPARTURE_IN_PAST", "Departure must be in the future")
    if "bus_id" in changes:
        await available_bus(db, route.carrier_id, changes["bus_id"])
    if await db.scalar(select(Booking.id).where(Booking.route_id == route.id).limit(1)):
        raise ApiError(409, "ROUTE_HAS_BOOKINGS", "Route details are fixed after the first booking")
    for field, value in changes.items():
        setattr(route, field, value)
    record_audit(db, user.id, "route.updated", "route", route.id, {"fields": sorted(changes)})
    await db.commit()
    return route


async def cancel_or_archive_route(db: AsyncSession, user: User, route_id: uuid.UUID) -> None:
    route = await own_route(db, user, route_id, lock=True, include_archived=True)
    if route.archived_at is not None or route.status == RouteStatus.CANCELLED:
        return
    if route.status == RouteStatus.DRAFT:
        route.archived_at = datetime.now(UTC)
        record_audit(db, user.id, "route.archived", "route", route.id)
        await db.commit()
    elif route.status == RouteStatus.ACTIVE:
        await transition(db, user, route, RouteStatus.CANCELLED)
    else:
        raise ApiError(
            409, "ROUTE_NOT_CANCELLABLE", "Departed or completed routes cannot be cancelled"
        )
