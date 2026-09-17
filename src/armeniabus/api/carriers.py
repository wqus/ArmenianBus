import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.dependencies import require_role
from armeniabus.api.errors import ErrorBody
from armeniabus.infrastructure.db.session import get_db_session
from armeniabus.modules.carriers import service
from armeniabus.modules.carriers.models import CarrierProfile, CarrierStatus
from armeniabus.modules.carriers.schemas import (
    CarrierInput,
    CarrierPage,
    CarrierPublic,
    CarrierStatusInput,
    CarrierUpdate,
)
from armeniabus.modules.users.models import User, UserRole

RESOURCE_ERRORS = {status: {"model": ErrorBody} for status in (401, 403, 404, 409, 422)}
router = APIRouter(prefix="/api/v1", tags=["carriers"], responses=RESOURCE_ERRORS)
DbSession = Annotated[AsyncSession, Depends(get_db_session)]
CarrierUser = Annotated[User, Depends(require_role(UserRole.CARRIER))]
AdminUser = Annotated[User, Depends(require_role(UserRole.ADMIN))]


@router.post("/carriers/me", response_model=CarrierPublic, status_code=201)
async def onboard(data: CarrierInput, user: CarrierUser, db: DbSession) -> CarrierProfile:
    return await service.create_profile(db, user, data)


@router.get("/carriers/me", response_model=CarrierPublic)
async def profile(user: CarrierUser, db: DbSession) -> CarrierProfile:
    return await service.own_profile(db, user.id)


@router.patch("/carriers/me", response_model=CarrierPublic)
async def edit_profile(data: CarrierUpdate, user: CarrierUser, db: DbSession) -> CarrierProfile:
    return await service.update_profile(db, user, data.model_dump(exclude_unset=True))


@router.get("/admin/carriers", response_model=CarrierPage, tags=["admin"])
async def carriers(
    user: AdminUser,
    db: DbSession,
    status: CarrierStatus | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0, le=10000)] = 0,
) -> CarrierPage:
    return await service.list_carriers(db, status, limit, offset)


@router.patch("/admin/carriers/{carrier_id}/status", response_model=CarrierPublic, tags=["admin"])
async def status_change(
    carrier_id: uuid.UUID, data: CarrierStatusInput, user: AdminUser, db: DbSession
) -> CarrierProfile:
    return await service.change_status(db, user, carrier_id, data.status)
