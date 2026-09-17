import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request

from armeniabus.api.bookings import DbSession, Passenger
from armeniabus.api.dependencies import require_role
from armeniabus.api.errors import ErrorBody
from armeniabus.modules.bookings.cabinet import (
    CabinetBooking,
    CabinetPage,
    list_cabinet,
)
from armeniabus.modules.bookings.models import BookingStatus
from armeniabus.modules.users.models import User, UserRole

router = APIRouter(
    prefix="/api/v1",
    tags=["cabinets"],
    responses={s: {"model": ErrorBody} for s in (401, 403, 404, 422)},
)
Carrier = Annotated[User, Depends(require_role(UserRole.CARRIER))]
Limit = Annotated[int, Query(ge=1, le=100)]
Offset = Annotated[int, Query(ge=0, le=10000)]
Segment = Literal["all", "upcoming", "history"]


@router.get("/cabinet/bookings", response_model=CabinetPage)
async def passenger_bookings(
    request: Request,
    user: Passenger,
    db: DbSession,
    limit: Limit = 20,
    offset: Offset = 0,
    segment: Segment = "all",
    status: BookingStatus | None = None,
) -> CabinetPage:
    return await list_cabinet(
        db,
        user,
        request.app.state.settings.paid_cancellation_cutoff_hours,
        limit,
        offset,
        segment,
        status,
    )


@router.get("/cabinet/bookings/{booking_id}", response_model=CabinetBooking)
async def passenger_details(
    booking_id: uuid.UUID, request: Request, user: Passenger, db: DbSession
) -> CabinetBooking:
    page = await list_cabinet(
        db,
        user,
        request.app.state.settings.paid_cancellation_cutoff_hours,
        1,
        0,
        "all",
        None,
        booking_id=booking_id,
    )
    return page.items[0]


@router.get("/carriers/me/bookings", response_model=CabinetPage)
async def carrier_bookings(
    request: Request,
    user: Carrier,
    db: DbSession,
    limit: Limit = 20,
    offset: Offset = 0,
    segment: Segment = "all",
    status: BookingStatus | None = None,
    route_id: uuid.UUID | None = None,
) -> CabinetPage:
    return await list_cabinet(
        db,
        user,
        request.app.state.settings.paid_cancellation_cutoff_hours,
        limit,
        offset,
        segment,
        status,
        carrier=True,
        route_id=route_id,
    )


@router.get("/carriers/me/bookings/{booking_id}", response_model=CabinetBooking)
async def carrier_details(
    booking_id: uuid.UUID, request: Request, user: Carrier, db: DbSession
) -> CabinetBooking:
    page = await list_cabinet(
        db,
        user,
        request.app.state.settings.paid_cancellation_cutoff_hours,
        1,
        0,
        "all",
        None,
        carrier=True,
        booking_id=booking_id,
    )
    return page.items[0]
