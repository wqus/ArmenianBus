import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from armeniabus.api.dependencies import require_role
from armeniabus.api.errors import ErrorBody
from armeniabus.infrastructure.db.session import get_db_session
from armeniabus.modules.routes import search, service
from armeniabus.modules.routes.models import Route, RouteStatus
from armeniabus.modules.routes.schemas import (
    RouteCreate,
    RoutePage,
    RoutePublic,
    RouteSearch,
    RouteSeats,
    RouteUpdate,
    SearchPage,
    SearchRoute,
)
from armeniabus.modules.users.models import User, UserRole

router = APIRouter(
    prefix="/api/v1/routes",
    tags=["routes"],
    responses={status: {"model": ErrorBody} for status in (401, 403, 404, 409, 422)},
)
DbSession = Annotated[AsyncSession, Depends(get_db_session)]
CarrierUser = Annotated[User, Depends(require_role(UserRole.CARRIER))]


@router.post("", response_model=RoutePublic, status_code=201)
async def create(data: RouteCreate, user: CarrierUser, db: DbSession) -> Route:
    return await service.create_route(db, user, data)


@router.get("/my", response_model=RoutePage)
async def list_own(
    user: CarrierUser,
    db: DbSession,
    status: RouteStatus | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> RoutePage:
    return await service.list_routes(db, user, limit, offset, status)


@router.get("/my/{route_id}", response_model=RoutePublic)
async def own_details(route_id: uuid.UUID, user: CarrierUser, db: DbSession) -> Route:
    return await service.own_route(db, user, route_id)


@router.get("/search", response_model=SearchPage)
async def find_routes(filters: Annotated[RouteSearch, Query()], db: DbSession) -> SearchPage:
    return await search.search_routes(db, filters)


@router.get("/{route_id}", response_model=SearchRoute)
async def details(route_id: uuid.UUID, db: DbSession) -> SearchRoute:
    return await search.route_details(db, route_id)


@router.get("/{route_id}/seats", response_model=RouteSeats)
async def seats(route_id: uuid.UUID, db: DbSession) -> RouteSeats:
    return await search.route_seats(db, route_id)


@router.patch("/{route_id}", response_model=RoutePublic)
async def edit(route_id: uuid.UUID, data: RouteUpdate, user: CarrierUser, db: DbSession) -> Route:
    return await service.update_route(db, user, route_id, data)


@router.delete("/{route_id}", status_code=204)
async def cancel(route_id: uuid.UUID, user: CarrierUser, db: DbSession) -> None:
    await service.cancel_or_archive_route(db, user, route_id)
