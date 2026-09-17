import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.dependencies import require_role
from armeniabus.api.errors import ApiError, ErrorBody
from armeniabus.infrastructure.db.session import get_db_session
from armeniabus.modules.admin import operations as service
from armeniabus.modules.admin.models import AuditLog
from armeniabus.modules.admin.monitoring import snapshot
from armeniabus.modules.admin.schemas import (
    AdminBooking,
    AdminPayment,
    AdminRoute,
    AuditPublic,
    NotificationPublic,
    NotificationRetryInput,
    OperationsHealth,
    Page,
    PaymentVerifyInput,
    ReasonInput,
    RefundRecordInput,
    UserStatusInput,
)
from armeniabus.modules.bookings.cabinet import (
    RefundPublic,
    effective_status,
    query,
    result,
)
from armeniabus.modules.bookings.models import Booking, BookingStatus
from armeniabus.modules.carriers.models import CarrierProfile
from armeniabus.modules.carriers.schemas import CarrierPublic
from armeniabus.modules.notifications.models import Notification
from armeniabus.modules.payments.models import Payment, PaymentStatus
from armeniabus.modules.payments.refunds import RefundCase
from armeniabus.modules.routes.models import Route, RouteStatus
from armeniabus.modules.users.models import User, UserRole, UserStatus
from armeniabus.modules.users.schemas import UserPublic

router = APIRouter(
    prefix="/api/v1/admin",
    tags=["admin"],
    responses={code: {"model": ErrorBody} for code in (401, 403, 404, 409, 422, 503)},
)
Admin = Annotated[User, Depends(require_role(UserRole.ADMIN))]
DbSession = Annotated[AsyncSession, Depends(get_db_session)]
Limit = Annotated[int, Query(ge=1, le=100)]
Offset = Annotated[int, Query(ge=0, le=10000)]


@router.get("/operations/health", response_model=OperationsHealth)
async def operations_health(request: Request, user: Admin, db: DbSession):
    return await snapshot(db, request.app.state.settings.worker_stale_seconds)


@router.get("/users", response_model=Page[UserPublic])
async def users(
    user: Admin,
    db: DbSession,
    limit: Limit = 20,
    offset: Offset = 0,
    status: UserStatus | None = None,
    role: UserRole | None = None,
):
    stmt = select(User).order_by(User.created_at.desc(), User.id.desc())
    if status is not None:
        stmt = stmt.where(User.status == status)
    if role is not None:
        stmt = stmt.where(User.role == role)
    return await service.page(db, stmt, limit, offset)


@router.get("/users/{user_id}", response_model=UserPublic)
async def user_details(user_id: uuid.UUID, user: Admin, db: DbSession):
    return await service.detail(db, User, user_id, "USER_NOT_FOUND")


@router.patch("/users/{user_id}/status", response_model=UserPublic)
async def user_status(user_id: uuid.UUID, data: UserStatusInput, user: Admin, db: DbSession):
    return await service.change_user_status(db, user, user_id, data)


@router.get("/carriers/{carrier_id}", response_model=CarrierPublic)
async def carrier_details(carrier_id: uuid.UUID, user: Admin, db: DbSession):
    return await service.detail(db, CarrierProfile, carrier_id, "CARRIER_NOT_FOUND")


@router.get("/routes", response_model=Page[AdminRoute])
async def routes(
    user: Admin,
    db: DbSession,
    limit: Limit = 20,
    offset: Offset = 0,
    status: RouteStatus | None = None,
    carrier_id: uuid.UUID | None = None,
):
    stmt = select(Route).order_by(Route.departure_at.desc(), Route.id.desc())
    if status is not None:
        stmt = stmt.where(Route.status == status)
    if carrier_id:
        stmt = stmt.where(Route.carrier_id == carrier_id)
    return await service.page(db, stmt, limit, offset)


@router.get("/routes/{route_id}", response_model=AdminRoute)
async def route_details(route_id: uuid.UUID, user: Admin, db: DbSession):
    return await service.detail(db, Route, route_id, "ROUTE_NOT_FOUND")


@router.post("/routes/{route_id}/cancel", response_model=AdminRoute)
async def route_cancel(route_id: uuid.UUID, data: ReasonInput, user: Admin, db: DbSession):
    return await service.cancel_route(db, user, route_id, data.reason)


@router.get("/bookings", response_model=Page[AdminBooking])
async def bookings(
    request: Request,
    user: Admin,
    db: DbSession,
    limit: Limit = 20,
    offset: Offset = 0,
    status: BookingStatus | None = None,
    route_id: uuid.UUID | None = None,
    passenger_id: uuid.UUID | None = None,
):
    stmt = query().order_by(Booking.created_at.desc(), Booking.id.desc())
    if status is not None:
        stmt = stmt.where(effective_status() == status)
    if route_id:
        stmt = stmt.where(Booking.route_id == route_id)
    if passenger_id:
        stmt = stmt.where(Booking.passenger_id == passenger_id)
    rows = await db.execute(stmt.limit(limit).offset(offset))
    return {
        "items": [
            AdminBooking(
                **result(
                    row, request.app.state.settings.paid_cancellation_cutoff_hours
                ).model_dump(),
                passenger_id=row.Booking.passenger_id,
            )
            for row in rows
        ],
        "limit": limit,
        "offset": offset,
    }


@router.get("/bookings/{booking_id}", response_model=AdminBooking)
async def booking_details(booking_id: uuid.UUID, request: Request, user: Admin, db: DbSession):
    row = (await db.execute(query().where(Booking.id == booking_id))).one_or_none()
    if row is None:
        raise ApiError(404, "BOOKING_NOT_FOUND", "Booking not found")
    return AdminBooking(
        **result(row, request.app.state.settings.paid_cancellation_cutoff_hours).model_dump(),
        passenger_id=row.Booking.passenger_id,
    )


@router.get("/payments", response_model=Page[AdminPayment])
async def payments(
    user: Admin,
    db: DbSession,
    limit: Limit = 20,
    offset: Offset = 0,
    status: PaymentStatus | None = None,
    review_required: bool | None = None,
    booking_id: uuid.UUID | None = None,
):
    stmt = select(Payment).order_by(Payment.created_at.desc(), Payment.id.desc())
    if status is not None:
        stmt = stmt.where(Payment.status == status)
    if review_required is not None:
        stmt = stmt.where(
            Payment.review_reason.is_not(None)
            if review_required
            else Payment.review_reason.is_(None)
        )
    if booking_id:
        stmt = stmt.where(Payment.booking_id == booking_id)
    return await service.page(db, stmt, limit, offset)


@router.get("/payments/{payment_id}", response_model=AdminPayment)
async def payment_details(payment_id: uuid.UUID, user: Admin, db: DbSession):
    return await service.detail(db, Payment, payment_id, "PAYMENT_NOT_FOUND")


@router.post("/payments/{payment_id}/verify", response_model=AdminPayment)
async def payment_verify(
    payment_id: uuid.UUID, data: PaymentVerifyInput, request: Request, user: Admin, db: DbSession
):
    return await service.verify_payment(
        db, user, payment_id, data.external_id, request.app.state.payment_provider
    )


@router.get("/refund-cases", response_model=Page[RefundPublic])
async def refunds(
    user: Admin,
    db: DbSession,
    limit: Limit = 20,
    offset: Offset = 0,
    status: Literal["OPEN", "REFUND_RECORDED"] | None = None,
):
    stmt = select(RefundCase).order_by(RefundCase.created_at, RefundCase.id)
    if status is not None:
        stmt = stmt.where(RefundCase.status == status)
    return await service.page(db, stmt, limit, offset)


@router.get("/refund-cases/{case_id}", response_model=RefundPublic)
async def refund_details(case_id: uuid.UUID, user: Admin, db: DbSession):
    return await service.detail(db, RefundCase, case_id, "REFUND_CASE_NOT_FOUND")


@router.post("/refund-cases/{case_id}/record", response_model=RefundPublic)
async def refund_record(case_id: uuid.UUID, data: RefundRecordInput, user: Admin, db: DbSession):
    return await service.record_refund(db, user, case_id, data.reference)


@router.get("/notifications", response_model=Page[NotificationPublic])
async def notifications(
    user: Admin,
    db: DbSession,
    limit: Limit = 20,
    offset: Offset = 0,
    status: Literal["PENDING", "SENT", "FAILED"] | None = None,
    booking_id: uuid.UUID | None = None,
):
    stmt = select(Notification).order_by(Notification.created_at.desc(), Notification.id.desc())
    if status is not None:
        stmt = stmt.where(Notification.status == status)
    if booking_id:
        stmt = stmt.where(Notification.booking_id == booking_id)
    return await service.page(db, stmt, limit, offset)


@router.get("/notifications/{notification_id}", response_model=NotificationPublic)
async def notification_details(notification_id: uuid.UUID, user: Admin, db: DbSession):
    return await service.detail(db, Notification, notification_id, "NOTIFICATION_NOT_FOUND")


@router.post("/notifications/{notification_id}/retry", response_model=NotificationPublic)
async def notification_retry(
    notification_id: uuid.UUID, data: NotificationRetryInput, user: Admin, db: DbSession
):
    return await service.retry_notification(db, user, notification_id, data)


@router.get("/audit", response_model=Page[AuditPublic])
async def audit(
    user: Admin,
    db: DbSession,
    limit: Limit = 20,
    offset: Offset = 0,
    actor_user_id: uuid.UUID | None = None,
    entity_id: uuid.UUID | None = None,
    entity_type: Annotated[str | None, Query(max_length=50)] = None,
    action: Annotated[str | None, Query(max_length=100)] = None,
):
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
    for field, value in (
        (AuditLog.actor_user_id, actor_user_id),
        (AuditLog.entity_id, entity_id),
        (AuditLog.entity_type, entity_type),
        (AuditLog.action, action),
    ):
        if value is not None:
            stmt = stmt.where(field == value)
    return await service.page(db, stmt, limit, offset)
