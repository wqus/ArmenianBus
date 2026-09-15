import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from armeniabus.api.auth import router as auth_router
from armeniabus.api.buses import router as buses_router
from armeniabus.api.carriers import router as carriers_router
from armeniabus.api.errors import error_response, register_error_handlers
from armeniabus.api.health import router as health_router
from armeniabus.core.config import Settings, get_settings
from armeniabus.core.logging import configure_logging, request_id_context
from armeniabus.infrastructure.db.session import create_session_factory


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        configure_logging(settings.log_level)
        engine, sessions = create_session_factory(settings.database_url)
        app.state.db_engine = engine
        app.state.db_sessions = sessions
        app.state.redis = Redis.from_url(settings.redis_url, decode_responses=True)
        try:
            yield
        finally:
            await app.state.redis.aclose()
            await engine.dispose()

    app = FastAPI(title="ArmeniaBus API", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID"],
    )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        incoming = request.headers.get("X-Request-ID", "")
        valid_incoming = incoming.isascii() and 0 < len(incoming) <= 128
        request_id = incoming if valid_incoming else str(uuid.uuid4())
        request.state.request_id = request_id
        token = request_id_context.set(request_id)
        try:
            try:
                response = await call_next(request)
            except Exception:
                logging.getLogger(__name__).exception("Unhandled request error")
                response = error_response(request, 500, "INTERNAL_ERROR", "Internal server error")
            response.headers["X-Request-ID"] = request_id
            return response
        finally:
            request_id_context.reset(token)

    register_error_handlers(app)
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(carriers_router)
    app.include_router(buses_router)
    return app


app = create_app()
