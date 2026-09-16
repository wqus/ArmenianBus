"""Public trip reads use one PostgreSQL statement per request, without a cache."""

import uuid
from datetime import UTC, datetime, time, timedelta

from sqlalchemy import func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.errors import ApiError
from armeniabus.modules.buses.models import Bus, Seat
from armeniabus.modules.carriers.models import CarrierProfile, CarrierStatus
from armeniabus.modules.routes.models import Route, RouteStatus
from armeniabus.modules.routes.schemas import (
    AvailableSeat,
    RoutePublic,
    RouteSearch,
    RouteSeats,
    SearchPage,
    SearchRoute,
)
from armeniabus.modules.users.models import User, UserStatus


def seat_inventory():
    # B6: derive HELD/PAID from bookings for the requested route, including held_until.
    # Seat itself has no mutable status. Before B6 there are no reservations.
    return select(
        Seat.id, Seat.bus_id, Seat.seat_number, literal("FREE").label("status")
    ).subquery()


def visible_routes(statement, now: datetime):
    return (
        statement.select_from(Route)
        .join(Bus, (Bus.id == Route.bus_id) & (Bus.carrier_id == Route.carrier_id))
        .join(CarrierProfile, CarrierProfile.id == Route.carrier_id)
        .join(User, User.id == CarrierProfile.user_id)
        .where(
            Route.status == RouteStatus.ACTIVE,
            Route.archived_at.is_(None),
            Route.departure_at > now,
            Bus.archived_at.is_(None),
            CarrierProfile.status == CarrierStatus.ACTIVE,
            User.status == UserStatus.ACTIVE,
        )
    )


def public_query(now: datetime):
    inventory = seat_inventory()
    counts = (
        select(
            inventory.c.bus_id,
            func.count().filter(inventory.c.status == "FREE").label("free_seats"),
        )
        .group_by(inventory.c.bus_id)
        .subquery()
    )
    return visible_routes(
        select(
            Route,
            CarrierProfile.company_name,
            Bus.name.label("bus_name"),
            Bus.capacity,
            func.coalesce(counts.c.free_seats, 0).label("free_seats"),
        ),
        now,
    ).outerjoin(counts, counts.c.bus_id == Route.bus_id)


def public_result(row) -> SearchRoute:
    return SearchRoute(
        **RoutePublic.model_validate(row.Route).model_dump(),
        company_name=row.company_name,
        bus_name=row.bus_name,
        capacity=row.capacity,
        free_seats=row.free_seats,
    )


async def search_routes(db: AsyncSession, filters: RouteSearch) -> SearchPage:
    start = datetime.combine(filters.date, time.min, tzinfo=UTC)
    query = public_query(datetime.now(UTC)).where(
        func.lower(Route.origin) == func.lower(filters.origin),
        func.lower(Route.destination) == func.lower(filters.destination),
        Route.departure_at >= start,
        Route.departure_at < start + timedelta(days=1),
    )
    rows = await db.execute(
        query.order_by(Route.departure_at, Route.id).limit(filters.limit).offset(filters.offset)
    )
    return SearchPage(
        items=[public_result(row) for row in rows], limit=filters.limit, offset=filters.offset
    )


async def route_details(db: AsyncSession, route_id: uuid.UUID) -> SearchRoute:
    row = (
        await db.execute(public_query(datetime.now(UTC)).where(Route.id == route_id))
    ).one_or_none()
    if row is None:
        raise ApiError(404, "ROUTE_NOT_FOUND", "Route not found")
    return public_result(row)


async def route_seats(db: AsyncSession, route_id: uuid.UUID) -> RouteSeats:
    inventory = seat_inventory()
    query = (
        visible_routes(
            select(
                Route.id,
                Route.bus_id,
                inventory.c.id.label("seat_id"),
                inventory.c.seat_number,
                inventory.c.status,
            ),
            datetime.now(UTC),
        )
        .outerjoin(inventory, inventory.c.bus_id == Route.bus_id)
        .where(Route.id == route_id)
    )
    rows = (await db.execute(query.order_by(inventory.c.seat_number))).all()
    if not rows:
        raise ApiError(404, "ROUTE_NOT_FOUND", "Route not found")
    seats = [
        AvailableSeat(id=row.seat_id, seat_number=row.seat_number, status=row.status)
        for row in rows
        if row.seat_id is not None
    ]
    return RouteSeats(
        route_id=route_id,
        bus_id=rows[0].bus_id,
        free_seats=sum(seat.status == "FREE" for seat in seats),
        seats=seats,
    )
