"""Operational actions; administrator bootstrap remains in service.py."""

import uuid

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.errors import ApiError
from armeniabus.modules.admin.audit import record_audit
from armeniabus.modules.admin.schemas import NotificationRetryInput, UserStatusInput
from armeniabus.modules.bookings.lifecycle import database_now, expire_booking
from armeniabus.modules.bookings.models import BookingStatus
from armeniabus.modules.carriers.models import CarrierProfile
from armeniabus.modules.notifications.models import Notification
from armeniabus.modules.notifications.outbox import enqueue
from armeniabus.modules.payments.models import Payment, PaymentStatus
from armeniabus.modules.payments.provider import ProviderError
from armeniabus.modules.payments.refunds import RefundCase
from armeniabus.modules.payments.service import apply_snapshot, lock_booking, record_failure
from armeniabus.modules.routes.models import Route, RouteStatus
from armeniabus.modules.routes.service import transition
from armeniabus.modules.users.models import RefreshSession, User, UserRole, UserStatus


async def detail(db, model, identifier, code):
    result = await db.get(model, identifier)
    if result is None:
        raise ApiError(404, code, "Resource not found")
    return result


async def page(db, statement, limit, offset):
    return {
        "items": list(await db.scalars(statement.limit(limit).offset(offset))),
        "limit": limit,
        "offset": offset,
    }


async def change_user_status(
    db: AsyncSession, actor: User, user_id: uuid.UUID, data: UserStatusInput
):
    # Match booking/payment mutations: carrier profile precedes all other locks.
    await db.scalar(
        select(CarrierProfile).where(CarrierProfile.user_id == user_id).with_for_update()
    )
    user = await db.scalar(
        select(User)
        .where(User.id == user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if user is None:
        raise ApiError(404, "USER_NOT_FOUND", "User not found")
    if user.role == UserRole.ADMIN:
        raise ApiError(409, "ADMIN_ACCOUNT_PROTECTED", "Admin accounts cannot be changed here")
    previous = user.status
    if previous == data.status:
        return user
    user.status = data.status
    if data.status == UserStatus.BLOCKED:
        now = await database_now(db)
        await db.execute(
            update(RefreshSession)
            .where(RefreshSession.user_id == user.id, RefreshSession.revoked_at.is_(None))
            .values(revoked_at=now)
        )
    record_audit(
        db,
        actor.id,
        "user.status_changed",
        "user",
        user.id,
        {"from": previous, "to": data.status, "reason": data.reason},
    )
    await db.commit()
    return user


async def cancel_route(db, actor, route_id, reason):
    carrier_id = await db.scalar(select(Route.carrier_id).where(Route.id == route_id))
    await db.scalar(select(CarrierProfile).where(CarrierProfile.id == carrier_id).with_for_update())
    route = await db.scalar(
        select(Route)
        .where(Route.id == route_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if route is None:
        raise ApiError(404, "ROUTE_NOT_FOUND", "Route not found")
    if route.status == RouteStatus.CANCELLED:
        return route
    if route.status != RouteStatus.ACTIVE:
        raise ApiError(409, "ROUTE_NOT_CANCELLABLE", "Only ACTIVE routes can be cancelled here")
    record_audit(db, actor.id, "route.admin_cancelled", "route", route.id, {"reason": reason})
    return await transition(db, actor, route, RouteStatus.CANCELLED)


async def record_refund(db, actor, case_id, reference):
    payment_id = await db.scalar(select(RefundCase.payment_id).where(RefundCase.id == case_id))
    if payment_id is None:
        raise ApiError(404, "REFUND_CASE_NOT_FOUND", "Refund case not found")
    booking_id = await db.scalar(select(Payment.booking_id).where(Payment.id == payment_id))
    _, _, _, booking = await lock_booking(db, booking_id)
    payment = await db.scalar(
        select(Payment)
        .where(Payment.id == payment_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    case = await db.scalar(
        select(RefundCase)
        .where(RefundCase.id == case_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if case.status == "REFUND_RECORDED":
        if case.resolution_reference == reference:
            return case
        raise ApiError(409, "REFUND_ALREADY_RECORDED", "A different refund reference is recorded")
    if payment.status != PaymentStatus.SUCCEEDED or booking.status in (
        BookingStatus.PAID,
        BookingStatus.COMPLETED,
    ):
        raise ApiError(
            409, "REFUND_NOT_RECORDABLE", "Cancel the paid booking before recording a refund"
        )
    now = await database_now(db)
    if booking.status == BookingStatus.HELD and not expire_booking(db, booking, now):
        booking.status = BookingStatus.CANCELLED
        record_audit(
            db,
            actor.id,
            "booking.cancelled",
            "booking",
            booking.id,
            {"reason": "manual_refund_recorded"},
        )
        await enqueue(db, booking, "cancelled")
    case.status = "REFUND_RECORDED"
    case.resolution_reference = reference
    case.resolved_at = now
    case.resolved_by_user_id = actor.id
    if payment.review_reason == "REFUND_REQUIRED":
        payment.review_reason = None
    record_audit(
        db,
        actor.id,
        "refund.recorded",
        "refund_case",
        case.id,
        {"reference": reference, "payment_id": str(payment.id)},
    )
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        if "uq_refund_cases_resolution_reference" in str(exc.orig):
            raise ApiError(
                409, "REFUND_REFERENCE_USED", "Refund reference is already recorded"
            ) from None
        raise
    return case


async def retry_notification(db, actor, notification_id, data: NotificationRetryInput):
    item = await db.scalar(
        select(Notification)
        .where(Notification.id == notification_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if item is None:
        raise ApiError(404, "NOTIFICATION_NOT_FOUND", "Notification not found")
    now = await database_now(db)
    if (
        item.status != "FAILED"
        or item.retry_generation != data.expected_generation
        or (item.lease_until is not None and item.lease_until > now)
    ):
        raise ApiError(
            409, "NOTIFICATION_NOT_RETRYABLE", "Reload notification state before retrying"
        )
    record_audit(
        db,
        actor.id,
        "notification.retry_requested",
        "notification",
        item.id,
        {
            "reason": data.reason,
            "previous_attempts": item.attempts,
            "generation": item.retry_generation + 1,
        },
    )
    item.status = "PENDING"
    item.retry_generation += 1
    item.attempts = 0
    item.last_error = None
    item.lease_until = item.lease_token = None
    item.next_attempt_at = now
    await db.commit()
    return item


async def verify_payment(db, actor, payment_id, external_id, provider):
    payment = await detail(db, Payment, payment_id, "PAYMENT_NOT_FOUND")
    candidate = str(external_id) if external_id else payment.external_id
    if not candidate:
        raise ApiError(
            409, "EXTERNAL_ID_REQUIRED", "Find the payment in the provider dashboard first"
        )
    if payment.external_id and candidate != payment.external_id:
        raise ApiError(
            409, "PAYMENT_EXTERNAL_ID_CONFLICT", "Payment already has a different external ID"
        )
    if not provider.settings.payments_enabled:
        raise ApiError(503, "PAYMENTS_DISABLED", "Payments are disabled")
    if (
        payment.shop_id != provider.settings.yookassa_shop_id
        or payment.test_mode != provider.settings.yookassa_test_mode
    ):
        raise ApiError(
            409, "PROVIDER_CONFIGURATION_CHANGED", "Use the original payment shop and mode"
        )
    record_audit(db, actor.id, "payment.verification_requested", "payment", payment.id)
    await db.commit()  # Durable request audit; no locks held during provider GET.
    try:
        snapshot = await provider.get(candidate)
    except ProviderError as exc:
        await record_failure(db, payment.id, exc.code)
        raise ApiError(503, exc.code, "Payment verification temporarily unavailable") from None
    if str(snapshot.id) != candidate:
        raise ApiError(503, "PROVIDER_INVALID_RESPONSE", "Provider returned a different payment")
    return await apply_snapshot(db, payment.id, snapshot, resolve_terminal_review=True)
