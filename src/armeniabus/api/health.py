import asyncio
import logging

from fastapi import APIRouter, Request
from sqlalchemy import text

from src.armeniabus.api.errors import ApiError, ErrorBody

router = APIRouter(prefix="/api/v1/health", tags=["health"])
logger = logging.getLogger(__name__)


@router.get("/live", response_model=dict[str, str])
async def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get(
    "/ready",
    response_model=dict[str, str],
    responses={503: {"model": ErrorBody, "description": "Dependency unavailable"}},
)
async def ready(request: Request) -> dict[str, str]:
    try:
        async def check_database() -> None:
            async with request.app.state.db_engine.connect() as connection:
                await connection.execute(text("SELECT 1"))

        await asyncio.wait_for(check_database(), timeout=2)
        await asyncio.wait_for(request.app.state.redis.ping(), timeout=2)
    except Exception:
        logger.warning("Readiness dependency unavailable")
        raise ApiError(503, "DEPENDENCY_UNAVAILABLE", "Service is not ready") from None
    return {"status": "ok"}
