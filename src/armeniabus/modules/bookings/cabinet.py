import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict
from sqlalchemy import case, func, select

from armeniabus.api.errors import ApiError
from armeniabus.modules.bookings.models import Booking, BookingStatus
from armeniabus.modules.bookings.policy import paid_cancellation_allowed
from armeniabus.modules.bookings.schemas import BookingPublic
from armeniabus.modules.buses.models import Seat
from armeniabus.modules.carriers.models import CarrierProfile
from armeniabus.modules.carriers.service import own_profile
from armeniabus.modules.payments.models import Payment
from armeniabus.modules.payments.refunds import RefundCase
from armeniabus.modules.routes.models import Route


class CabinetBooking(BookingPublic):
    origin: str
    destination: str
    departure_at: datetime
    route_status: str
    seat_number: int
    company_name: str
    payment_status: str | None
    refund_required: bool
    refund_status: str | None
    cancellation_allowed: bool


class CabinetPage(BaseModel):
    items: list[CabinetBooking]
    limit: int
    offset: int


class RefundPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    payment_id: uuid.UUID
    reason: str
    created_at: datetime
    status: str
    resolution_reference: str | None
    resolved_at: datetime | None
    resolved_by_user_id: uuid.UUID | None


class RefundPage(BaseModel):
    items: list[RefundPublic]
    limit: int
    offset: int


def effective_status():
    return case(
        (
            (Booking.status == "HELD") & (Booking.held_until <= func.statement_timestamp()),
            "EXPIRED",
        ),
        else_=Booking.status,
    )


def query():
    return (
        select(
            Booking,
            Route,
            Seat.seat_number,
            CarrierProfile.company_name,
            Payment.status.label("payment_status"),
            RefundCase.id.label("refund_id"),
            RefundCase.status.label("refund_status"),
            effective_status().label("effective_status"),
            func.statement_timestamp().label("read_at"),
        )
        .join(Route, Route.id == Booking.route_id)
        .join(Seat, Seat.id == Booking.seat_id)
        .join(CarrierProfile, CarrierProfile.id == Route.carrier_id)
        .outerjoin(Payment, Payment.booking_id == Booking.id)
        .outerjoin(RefundCase, RefundCase.payment_id == Payment.id)
    )


def result(row, cutoff_hours):
    booking, route = row.Booking, row.Route
    allowed = row.effective_status == "HELD" or (
        row.effective_status == "PAID"
        and row.payment_status == "SUCCEEDED"
        and paid_cancellation_allowed(route.status, route.departure_at, row.read_at, cutoff_hours)
    )
    return CabinetBooking(
        **BookingPublic.model_validate(booking).model_dump(exclude={"status"}),
        status=row.effective_status,
        origin=route.origin,
        destination=route.destination,
        departure_at=route.departure_at,
        route_status=route.status,
        seat_number=row.seat_number,
        company_name=row.company_name,
        payment_status=row.payment_status,
        refund_required=row.refund_status == "OPEN",
        refund_status=row.refund_status,
        cancellation_allowed=allowed,
    )


async def list_cabinet(
    db,
    user,
    cutoff_hours,
    limit,
    offset,
    segment: Literal["all", "upcoming", "history"],
    status: BookingStatus | None,
    *,
    carrier=False,
    route_id=None,
    booking_id=None,
):
    statement = query()
    if carrier:
        profile = await own_profile(db, user.id, active=True)
        statement = statement.where(Route.carrier_id == profile.id)
        if route_id and not await db.scalar(
            select(Route.id).where(Route.id == route_id, Route.carrier_id == profile.id)
        ):
            raise ApiError(404, "ROUTE_NOT_FOUND", "Route not found")
    else:
        statement = statement.where(Booking.passenger_id == user.id)
    if route_id:
        statement = statement.where(Route.id == route_id)
    if booking_id:
        statement = statement.where(Booking.id == booking_id)
    upcoming = (
        (Route.departure_at > func.statement_timestamp())
        & (Route.status == "ACTIVE")
        & effective_status().in_(["HELD", "PAID"])
    )
    if segment != "all":
        statement = statement.where(upcoming if segment == "upcoming" else ~upcoming)
    if status:
        statement = statement.where(effective_status() == status)
    rows = await db.execute(
        statement.order_by(Booking.created_at.desc(), Booking.id.desc()).limit(limit).offset(offset)
    )
    items = [result(row, cutoff_hours) for row in rows]
    if booking_id and not items:
        raise ApiError(404, "BOOKING_NOT_FOUND", "Booking not found")
    return CabinetPage(items=items, limit=limit, offset=offset)
