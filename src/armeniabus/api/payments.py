import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.dependencies import require_role
from armeniabus.api.errors import ApiError, ErrorBody
from armeniabus.infrastructure.db.session import get_db_session
from armeniabus.modules.payments import service
from armeniabus.modules.payments.provider import ProviderError
from armeniabus.modules.payments.schemas import PaymentNotification, PaymentPublic, PayRequest
from armeniabus.modules.users.models import User, UserRole

router = APIRouter(
    prefix="/api/v1",
    tags=["payments"],
    responses={code: {"model": ErrorBody} for code in (401, 403, 404, 409, 410, 422, 503)},
)
DbSession = Annotated[AsyncSession, Depends(get_db_session)]
Passenger = Annotated[User, Depends(require_role(UserRole.PASSENGER))]


@router.post("/bookings/{booking_id}/pay", response_model=PaymentPublic)
async def pay(
    booking_id: uuid.UUID,
    request: Request,
    user: Passenger,
    db: DbSession,
    idempotency_key: Annotated[uuid.UUID, Header()],
    body: PayRequest | None = None,
) -> PaymentPublic:
    payment = await service.prepare(
        db, user, booking_id, idempotency_key, request.app.state.settings
    )
    try:
        await service.synchronize(db, payment.id, request.app.state.payment_provider)
    except ProviderError as exc:
        raise ApiError(
            503, exc.code, "Payment provider is unavailable; retain the idempotency key"
        ) from None
    return await service.own_payment(db, user, booking_id)


@router.get("/bookings/{booking_id}/payment", response_model=PaymentPublic)
async def payment_details(booking_id: uuid.UUID, user: Passenger, db: DbSession) -> PaymentPublic:
    return await service.own_payment(db, user, booking_id)


@router.post("/webhooks/payments")
async def notification(data: PaymentNotification, request: Request, db: DbSession) -> dict:
    try:
        await service.webhook(db, request.app.state.payment_provider, str(data.object.id))
    except ProviderError as exc:
        raise ApiError(503, exc.code, "Payment verification temporarily unavailable") from None
    return {"status": "ok"}
