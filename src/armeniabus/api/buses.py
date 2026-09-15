import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from src.armeniabus.api.dependencies import require_role
from src.armeniabus.api.errors import ErrorBody
from src.armeniabus.infrastructure.db.session import get_db_session
from src.armeniabus.modules.buses import service
from src.armeniabus.modules.buses.schemas import BusCreate, BusPage, BusPublic, BusUpdate
from src.armeniabus.modules.users.models import User, UserRole

router = APIRouter(
    prefix="/api/v1/buses",
    tags=["buses"],
    responses={status: {"model": ErrorBody} for status in (401, 403, 404, 409, 422)},
)
DbSession = Annotated[AsyncSession, Depends(get_db_session)]
CarrierUser = Annotated[User, Depends(require_role(UserRole.CARRIER))]


@router.post("", response_model=BusPublic, status_code=201)
async def create(data: BusCreate, user: CarrierUser, db: DbSession) -> BusPublic:
    return await service.create_bus(db, user, data)


@router.get("", response_model=BusPage)
async def list_own(
    user: CarrierUser,
    db: DbSession,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> BusPage:
    return await service.list_buses(db, user, limit, offset)


@router.get("/{bus_id}", response_model=BusPublic)
async def details(bus_id: uuid.UUID, user: CarrierUser, db: DbSession) -> BusPublic:
    return await service.bus_details(db, await service.owned_bus(db, user, bus_id))


@router.patch("/{bus_id}", response_model=BusPublic)
async def edit(bus_id: uuid.UUID, data: BusUpdate, user: CarrierUser, db: DbSession) -> BusPublic:
    return await service.rename_bus(db, user, bus_id, data.name)


@router.delete("/{bus_id}", status_code=204)
async def archive(bus_id: uuid.UUID, user: CarrierUser, db: DbSession) -> None:
    await service.archive_bus(db, user, bus_id)
