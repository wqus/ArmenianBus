import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.dependencies import require_role
from armeniabus.api.errors import ErrorBody
from armeniabus.infrastructure.db.session import get_db_session
from armeniabus.modules.bookings import service
from armeniabus.modules.bookings.models import Booking
from armeniabus.modules.bookings.schemas import BookingCreate, BookingPage, BookingPublic
from armeniabus.modules.users.models import User, UserRole

router = APIRouter(
    prefix="/api/v1/bookings",
    tags=["bookings"],
    responses={status: {"model": ErrorBody} for status in (401, 403, 404, 409, 422)},
)
DbSession = Annotated[AsyncSession, Depends(get_db_session)]
Passenger = Annotated[User, Depends(require_role(UserRole.PASSENGER))]


@router.post("", response_model=BookingPublic, status_code=201)
async def create(data: BookingCreate, request: Request, user: Passenger, db: DbSession) -> Booking:
    return await service.create_booking(
        db, user, data, request.app.state.settings.booking_hold_minutes
    )


@router.get("/my", response_model=BookingPage)
async def list_own(
    user: Passenger,
    db: DbSession,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0, le=10000)] = 0,
) -> BookingPage:
    return await service.list_bookings(db, user, limit, offset)


@router.get("/{booking_id}", response_model=BookingPublic)
async def details(booking_id: uuid.UUID, user: Passenger, db: DbSession) -> BookingPublic:
    return await service.booking_details(db, user, booking_id)


@router.delete("/{booking_id}", status_code=204)
async def cancel(
    booking_id: uuid.UUID,
    request: Request,
    user: Passenger,
    db: DbSession,
    hold_only: bool = False,
) -> None:
    await service.cancel_booking(
        db,
        user,
        booking_id,
        request.app.state.settings.paid_cancellation_cutoff_hours,
        hold_only=hold_only,
    )
