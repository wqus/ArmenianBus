import uuid
from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.errors import ApiError
from armeniabus.core.config import Settings
from armeniabus.modules.admin.audit import record_audit
from armeniabus.modules.bookings.lifecycle import database_now, expire_booking
from armeniabus.modules.bookings.models import Booking, BookingStatus
from armeniabus.modules.carriers.models import CarrierProfile, CarrierStatus
from armeniabus.modules.notifications.outbox import enqueue
from armeniabus.modules.payments.models import Payment, PaymentStatus
from armeniabus.modules.payments.provider import ProviderError, ProviderPayment, YooKassa
from armeniabus.modules.payments.refunds import request_refund
from armeniabus.modules.payments.schemas import PaymentPublic
from armeniabus.modules.routes.models import Route, RouteStatus
from armeniabus.modules.users.models import User, UserStatus


async def lock_booking(db: AsyncSession, booking_id: uuid.UUID):
    # All payment state changes follow profile -> route -> booking -> payment.
    route_id = await db.scalar(select(Booking.route_id).where(Booking.id == booking_id))
    carrier_id = await db.scalar(select(Route.carrier_id).where(Route.id == route_id))
    carrier = await db.scalar(
        select(CarrierProfile)
        .where(CarrierProfile.id == carrier_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    route = await db.scalar(
        select(Route)
        .where(Route.id == route_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    booking = await db.scalar(
        select(Booking)
        .where(Booking.id == booking_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    owner_status = await db.scalar(select(User.status).where(User.id == carrier.user_id))
    return carrier, owner_status, route, booking


def bookable(carrier, owner_status, route, booking, now):
    return (
        booking.status == BookingStatus.HELD
        and booking.held_until > now
        and route.status == RouteStatus.ACTIVE
        and route.departure_at > now
        and route.archived_at is None
        and carrier.status == CarrierStatus.ACTIVE
        and owner_status == UserStatus.ACTIVE
    )


async def prepare(
    db: AsyncSession, user: User, booking_id: uuid.UUID, key: uuid.UUID, settings: Settings
) -> Payment:
    owned = await db.scalar(
        select(Booking.id).where(Booking.id == booking_id, Booking.passenger_id == user.id)
    )
    if owned is None:
        raise ApiError(404, "BOOKING_NOT_FOUND", "Booking not found")
    if not settings.payments_enabled:
        raise ApiError(503, "PAYMENTS_DISABLED", "Payments are not configured")
    carrier, owner_status, route, booking = await lock_booking(db, booking_id)
    existing = await db.scalar(select(Payment).where(Payment.booking_id == booking.id))
    if existing is not None and existing.client_key != key:
        raise ApiError(409, "IDEMPOTENCY_CONFLICT", "Use the original payment idempotency key")
    if existing is not None and existing.status != PaymentStatus.PENDING:
        await db.commit()
        return existing
    now = await database_now(db)
    if expire_booking(db, booking, now) or booking.status == BookingStatus.EXPIRED:
        await db.commit()
        raise ApiError(410, "HOLD_EXPIRED", "Booking hold has expired")
    if not bookable(carrier, owner_status, route, booking, now):
        raise ApiError(409, "PAYMENT_NOT_AVAILABLE", "Booking cannot be paid")
    if existing is not None:
        await db.commit()
        return existing
    payment_id = uuid.uuid4()
    payload = {
        "amount": {"value": str(booking.amount), "currency": booking.currency},
        "capture": True,
        "confirmation": {"type": "redirect", "return_url": str(settings.payment_return_url)},
        "description": f"ArmeniaBus booking {booking.id}",
        "metadata": {"booking_id": str(booking.id), "payment_id": str(payment_id)},
    }
    payment = Payment(
        id=payment_id,
        booking_id=booking.id,
        passenger_id=user.id,
        client_key=key,
        shop_id=settings.yookassa_shop_id,
        test_mode=settings.yookassa_test_mode,
        amount=booking.amount,
        currency=booking.currency,
        request_payload=payload,
        created_at=now,
        next_check_at=now + timedelta(seconds=settings.payment_poll_seconds),
    )
    db.add(payment)
    try:
        await db.flush()
        record_audit(db, user.id, "payment.created", "payment", payment.id)
        await db.commit()  # Durable intent BEFORE any external request.
    except IntegrityError as exc:
        await db.rollback()
        if any(
            name in str(exc.orig) for name in ("uq_payment_client_key", "payments_booking_id_key")
        ):
            raise ApiError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key is already used") from None
        raise
    return payment


def review(db, payment, reason):
    if payment.review_reason != reason:
        payment.review_reason = reason
        record_audit(db, None, "payment.review_required", "payment", payment.id, {"reason": reason})


async def apply_snapshot(
    db: AsyncSession, payment_id: uuid.UUID, snapshot: ProviderPayment
) -> Payment:
    booking_id = await db.scalar(select(Payment.booking_id).where(Payment.id == payment_id))
    carrier, owner_status, route, booking = await lock_booking(db, booking_id)
    payment = await db.scalar(
        select(Payment)
        .where(Payment.id == payment_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    now = await database_now(db)
    valid = (
        snapshot.amount.value == payment.amount == booking.amount
        and snapshot.amount.currency == payment.currency == booking.currency
        and snapshot.recipient.account_id == payment.shop_id
        and snapshot.test == payment.test_mode
        and snapshot.metadata.get("booking_id") == str(booking.id)
        and snapshot.metadata.get("payment_id") == str(payment.id)
        and (payment.external_id is None or payment.external_id == str(snapshot.id))
    )
    if not valid:
        review(db, payment, "PROVIDER_DATA_MISMATCH")
        await db.commit()
        return payment
    payment.external_id = str(snapshot.id)
    payment.last_error = None
    if payment.status != PaymentStatus.PENDING:
        # Duplicates and out-of-order pending notifications never regress terminal states.
        expected = {"succeeded": "SUCCEEDED", "canceled": "CANCELED"}.get(snapshot.status)
        if expected and payment.status != expected:
            review(db, payment, "PROVIDER_STATE_CONFLICT")
        await db.commit()
        return payment
    if payment.review_reason and snapshot.status in ("pending", "succeeded", "canceled"):
        # A newly verified matching object can resolve an earlier uncertain/mismatched response.
        previous_review = payment.review_reason
        payment.review_reason = None
        record_audit(
            db,
            None,
            "payment.review_rechecked",
            "payment",
            payment.id,
            {"previous_reason": previous_review},
        )
    if snapshot.status == "succeeded":
        if not snapshot.paid:
            review(db, payment, "PROVIDER_DATA_MISMATCH")
        else:
            payment.status = PaymentStatus.SUCCEEDED
            if bookable(carrier, owner_status, route, booking, now):
                booking.status = BookingStatus.PAID
                record_audit(db, None, "booking.paid", "booking", booking.id)
                await enqueue(db, booking, "paid")
            else:
                expire_booking(db, booking, now)
                review(db, payment, "REFUND_REQUIRED")
                await request_refund(db, payment, "LATE_OR_UNAVAILABLE_BOOKING")
                await enqueue(db, booking, "refund_required")
            record_audit(db, None, "payment.succeeded", "payment", payment.id)
    elif snapshot.status == "canceled":
        payment.status = PaymentStatus.CANCELED
        if not expire_booking(db, booking, now) and booking.status == BookingStatus.HELD:
            booking.status = BookingStatus.CANCELLED
            record_audit(
                db, None, "booking.cancelled", "booking", booking.id, {"reason": "payment_canceled"}
            )
            await enqueue(db, booking, "cancelled")
        record_audit(db, None, "payment.canceled", "payment", payment.id)
    elif snapshot.status == "waiting_for_capture":
        review(db, payment, "UNEXPECTED_CAPTURE_REQUIRED")
    elif snapshot.confirmation and snapshot.confirmation.confirmation_url:
        url = snapshot.confirmation.confirmation_url
        if url.scheme == "https" and len(str(url)) <= 2048:
            payment.confirmation_url = str(url)
        else:
            review(db, payment, "INVALID_CONFIRMATION_URL")
    await db.commit()
    return payment


async def record_failure(db, payment_id, code):
    payment = await db.scalar(
        select(Payment)
        .where(Payment.id == payment_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if payment.status == PaymentStatus.PENDING:
        payment.last_error = code
        if code == "PROVIDER_REJECTED" and payment.external_id is None:
            payment.status = PaymentStatus.FAILED
            record_audit(db, None, "payment.failed", "payment", payment.id)
    await db.commit()


async def synchronize(db: AsyncSession, payment_id: uuid.UUID, provider: YooKassa) -> Payment:
    payment = await db.get(Payment, payment_id, populate_existing=True)
    booking = await db.get(Booking, payment.booking_id, populate_existing=True)
    now = await database_now(db)
    await db.commit()  # No row locks / open transaction during HTTP.
    if payment.status != PaymentStatus.PENDING or payment.review_reason:
        return payment
    if (
        payment.shop_id != provider.settings.yookassa_shop_id
        or payment.test_mode != provider.settings.yookassa_test_mode
    ):
        raise ProviderError("PROVIDER_CONFIGURATION_CHANGED")
    if payment.external_id is None:
        if (
            booking.status != BookingStatus.HELD
            or booking.held_until <= now
            or now >= payment.created_at + timedelta(hours=23)
        ):
            payment = await db.scalar(
                select(Payment)
                .where(Payment.id == payment_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            if payment.status == PaymentStatus.PENDING:
                review(db, payment, "UNKNOWN_RESULT_REQUIRES_REVIEW")
            await db.commit()
            return payment
    try:
        snapshot = (
            await provider.get(payment.external_id)
            if payment.external_id
            else await provider.create(payment.id, payment.request_payload)
        )
    except ProviderError as exc:
        await record_failure(db, payment.id, exc.code)
        raise
    return await apply_snapshot(db, payment.id, snapshot)


async def own_payment(db: AsyncSession, user: User, booking_id: uuid.UUID) -> PaymentPublic:
    row = (
        await db.execute(
            select(Payment, Booking, func.statement_timestamp())
            .join(Booking, Booking.id == Payment.booking_id)
            .where(Payment.booking_id == booking_id, Booking.passenger_id == user.id)
            .execution_options(populate_existing=True)
        )
    ).one_or_none()
    if row is None:
        raise ApiError(404, "PAYMENT_NOT_FOUND", "Payment not found")
    payment, booking, now = row
    result = PaymentPublic.model_validate(payment)
    if (
        payment.status != PaymentStatus.PENDING
        or payment.review_reason
        or booking.status != BookingStatus.HELD
        or booking.held_until <= now
    ):
        result.confirmation_url = None
    return result


async def webhook(db: AsyncSession, provider: YooKassa, external_id: str):
    try:
        snapshot = await provider.get(external_id)
    except ProviderError as exc:
        if exc.code == "PROVIDER_NOT_FOUND":
            return
        raise
    payment_id = await db.scalar(select(Payment.id).where(Payment.external_id == external_id))
    if payment_id is None:
        # Recover an early notification using metadata from verified GET, never the webhook body.
        try:
            candidate = uuid.UUID(snapshot.metadata.get("payment_id", ""))
        except ValueError:
            return
        payment_id = await db.scalar(select(Payment.id).where(Payment.id == candidate))
    if payment_id is not None:
        await apply_snapshot(db, payment_id, snapshot)


async def reconcile_batch(sessions, provider: YooKassa, settings: Settings) -> int:
    if not settings.payments_enabled:
        return 0
    async with sessions() as db:
        now = await database_now(db)
        ids = list(
            await db.scalars(
                select(Payment.id)
                .where(
                    Payment.status == PaymentStatus.PENDING,
                    Payment.next_check_at <= now,
                    Payment.review_reason.is_(None),
                )
                .order_by(Payment.next_check_at, Payment.id)
                .limit(settings.payment_batch_size)
            )
        )
    count = 0
    for payment_id in ids:
        async with sessions() as db:
            now = await database_now(db)
            claimed = await db.scalar(
                update(Payment)
                .where(
                    Payment.id == payment_id,
                    Payment.status == PaymentStatus.PENDING,
                    Payment.next_check_at <= now,
                    Payment.review_reason.is_(None),
                )
                .values(next_check_at=now + timedelta(seconds=settings.payment_poll_seconds))
                .returning(Payment.id)
            )
            await db.commit()
            if claimed is None:
                continue
            try:
                await synchronize(db, payment_id, provider)
                count += 1
            except ProviderError:
                pass  # Durable error + scheduled retry; no provider payloads in logs.
    return count
