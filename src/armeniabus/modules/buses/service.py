import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.errors import ApiError
from armeniabus.modules.admin.audit import record_audit
from armeniabus.modules.buses.models import Bus, Seat
from armeniabus.modules.buses.schemas import (
    BusCreate,
    BusPage,
    BusPublic,
    BusSummary,
    SeatPublic,
)
from armeniabus.modules.carriers.service import own_profile
from armeniabus.modules.users.models import User


async def bus_details(db: AsyncSession, bus: Bus) -> BusPublic:
    seats = await db.scalars(select(Seat).where(Seat.bus_id == bus.id).order_by(Seat.seat_number))
    return BusPublic(
        **BusSummary.model_validate(bus).model_dump(),
        seats=[SeatPublic.model_validate(seat) for seat in seats],
    )


async def owned_bus(db: AsyncSession, user: User, bus_id: uuid.UUID, *, lock: bool = False) -> Bus:
    # Mutations and administrative blocking lock the same carrier row first.
    profile = await own_profile(db, user.id, active=True, lock=lock)
    query = select(Bus).where(
        Bus.id == bus_id, Bus.carrier_id == profile.id, Bus.archived_at.is_(None)
    )
    if lock:
        query = query.with_for_update()
    bus = await db.scalar(query)
    if bus is None:
        raise ApiError(404, "BUS_NOT_FOUND", "Bus not found")
    return bus


async def create_bus(db: AsyncSession, user: User, data: BusCreate) -> BusPublic:
    profile = await own_profile(db, user.id, active=True, lock=True)
    bus = Bus(carrier_id=profile.id, name=data.name, capacity=data.capacity)
    db.add(bus)
    await db.flush()
    db.add_all([Seat(bus_id=bus.id, seat_number=n) for n in range(1, data.capacity + 1)])
    record_audit(db, user.id, "bus.created", "bus", bus.id, {"capacity": data.capacity})
    await db.flush()
    result = await bus_details(db, bus)
    await db.commit()
    return result


async def list_buses(db: AsyncSession, user: User, limit: int, offset: int) -> BusPage:
    profile = await own_profile(db, user.id, active=True)
    buses = await db.scalars(
        select(Bus)
        .where(Bus.carrier_id == profile.id, Bus.archived_at.is_(None))
        .order_by(Bus.created_at, Bus.id)
        .limit(limit)
        .offset(offset)
    )
    return BusPage(
        items=[BusSummary.model_validate(bus) for bus in buses], limit=limit, offset=offset
    )


async def rename_bus(db: AsyncSession, user: User, bus_id: uuid.UUID, name: str) -> BusPublic:
    bus = await owned_bus(db, user, bus_id, lock=True)
    bus.name = name
    record_audit(db, user.id, "bus.updated", "bus", bus.id)
    result = await bus_details(db, bus)
    await db.commit()
    return result


async def archive_bus(db: AsyncSession, user: User, bus_id: uuid.UUID) -> None:
    bus = await owned_bus(db, user, bus_id, lock=True)
    bus.archived_at = datetime.now(UTC)
    record_audit(db, user.id, "bus.archived", "bus", bus.id)
    await db.commit()
