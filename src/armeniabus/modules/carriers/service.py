import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.errors import ApiError
from armeniabus.modules.admin.audit import record_audit
from armeniabus.modules.carriers.models import CarrierProfile, CarrierStatus
from armeniabus.modules.carriers.schemas import CarrierInput, CarrierPage, CarrierPublic
from armeniabus.modules.users.models import User


async def own_profile(
    db: AsyncSession, user_id: uuid.UUID, *, lock: bool = False, active: bool = False
) -> CarrierProfile:
    query = select(CarrierProfile).where(CarrierProfile.user_id == user_id)
    if lock:
        query = query.with_for_update()
    profile = await db.scalar(query)
    if profile is None:
        raise ApiError(404, "CARRIER_PROFILE_NOT_FOUND", "Complete carrier onboarding first")
    if active and profile.status != CarrierStatus.ACTIVE:
        raise ApiError(403, "CARRIER_NOT_ACTIVE", "Carrier must be active")
    return profile


async def create_profile(db: AsyncSession, user: User, data: CarrierInput) -> CarrierProfile:
    # Serialize onboarding for carrier accounts registered before profiles existed.
    await db.scalar(select(User).where(User.id == user.id).with_for_update())
    if await db.scalar(select(CarrierProfile.id).where(CarrierProfile.user_id == user.id)):
        raise ApiError(409, "CARRIER_PROFILE_EXISTS", "Carrier profile already exists")
    profile = CarrierProfile(user_id=user.id, **data.model_dump())
    db.add(profile)
    await db.flush()
    record_audit(db, user.id, "carrier.created", "carrier", profile.id)
    await db.commit()
    return profile


async def update_profile(db: AsyncSession, user: User, changes: dict[str, str]) -> CarrierProfile:
    profile = await own_profile(db, user.id, lock=True)
    if profile.status != CarrierStatus.PENDING:
        raise ApiError(409, "CARRIER_PROFILE_LOCKED", "Only pending profiles can be edited")
    for field, value in changes.items():
        setattr(profile, field, value)
    record_audit(db, user.id, "carrier.updated", "carrier", profile.id)
    await db.commit()
    return profile


async def list_carriers(
    db: AsyncSession, status: CarrierStatus | None, limit: int, offset: int
) -> CarrierPage:
    query = select(CarrierProfile).order_by(CarrierProfile.created_at, CarrierProfile.id)
    if status is not None:
        query = query.where(CarrierProfile.status == status)
    profiles = await db.scalars(query.limit(limit).offset(offset))
    return CarrierPage(
        items=[CarrierPublic.model_validate(profile) for profile in profiles],
        limit=limit,
        offset=offset,
    )


async def change_status(
    db: AsyncSession, actor: User, carrier_id: uuid.UUID, target: CarrierStatus
) -> CarrierProfile:
    profile = await db.scalar(
        select(CarrierProfile).where(CarrierProfile.id == carrier_id).with_for_update()
    )
    if profile is None:
        raise ApiError(404, "CARRIER_NOT_FOUND", "Carrier not found")
    previous = profile.status
    if previous == target:
        return profile
    allowed = {
        CarrierStatus.PENDING: {CarrierStatus.ACTIVE},
        CarrierStatus.ACTIVE: {CarrierStatus.BLOCKED},
        CarrierStatus.BLOCKED: {CarrierStatus.ACTIVE},
    }
    if target not in allowed[CarrierStatus(previous)]:
        raise ApiError(
            409, "INVALID_CARRIER_TRANSITION", "Carrier status transition is not allowed"
        )
    profile.status = target
    record_audit(
        db,
        actor.id,
        "carrier.status_changed",
        "carrier",
        profile.id,
        {"from": previous, "to": target},
    )
    await db.commit()
    return profile
