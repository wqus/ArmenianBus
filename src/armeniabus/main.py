import logging
import re
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from redis.asyncio import Redis

from armeniabus.api.admin import router as admin_router
from armeniabus.api.auth import router as auth_router
from armeniabus.api.body_limit import BodyLimitMiddleware
from armeniabus.api.bookings import router as bookings_router
from armeniabus.api.buses import router as buses_router
from armeniabus.api.cabinets import router as cabinets_router
from armeniabus.api.carriers import router as carriers_router
from armeniabus.api.cities import router as cities_router
from armeniabus.api.errors import error_response, register_error_handlers
from armeniabus.api.health import router as health_router
from armeniabus.api.payments import router as payments_router
from armeniabus.api.routes import router as routes_router
from armeniabus.api.web_auth import router as web_auth_router
from armeniabus.core.config import Settings, get_settings
from armeniabus.core.logging import configure_logging, request_id_context
from armeniabus.infrastructure.db.session import create_session_factory
from armeniabus.modules.payments.provider import YooKassa


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        configure_logging(settings.log_level)
        engine, sessions = create_session_factory(settings.database_url)
        app.state.db_engine = engine
        app.state.db_sessions = sessions
        app.state.redis = Redis.from_url(settings.redis_url, decode_responses=True)
        app.state.payment_provider = YooKassa(settings)
        try:
            yield
        finally:
            await app.state.payment_provider.close()
            await app.state.redis.aclose()
            await engine.dispose()

    public_docs = settings.app_env != "production"
    app = FastAPI(
        title="armatrans API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/docs" if public_docs else None,
        redoc_url="/redoc" if public_docs else None,
        openapi_url="/openapi.json" if public_docs else None,
    )
    app.state.settings = settings
    app.add_middleware(
        BodyLimitMiddleware,
        max_bytes=settings.request_max_bytes,
        timeout_seconds=settings.request_body_timeout_seconds,
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
    # CORS also covers early host/body-limit errors for the configured frontend.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "Idempotency-Key",
            "X-Request-ID",
            "X-ArmeniaBus-Web",
        ],
    )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        incoming = request.headers.get("X-Request-ID", "")
        valid_incoming = re.fullmatch(r"[A-Za-z0-9._-]{1,128}", incoming) is not None
        request_id = incoming if valid_incoming else str(uuid.uuid4())
        request.state.request_id = request_id
        token = request_id_context.set(request_id)
        started = time.perf_counter()
        try:
            try:
                response = await call_next(request)
            except Exception as exc:
                logging.getLogger(__name__).error(
                    "Unhandled request error", extra={"error_type": type(exc).__name__}
                )
                response = error_response(request, 500, "INTERNAL_ERROR", "Internal server error")
            response.headers["X-Request-ID"] = request_id
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["X-Frame-Options"] = "DENY"
            response.headers["Referrer-Policy"] = "no-referrer"
            response.headers["Cache-Control"] = "no-store"
            if settings.app_env == "production":
                response.headers["Strict-Transport-Security"] = "max-age=31536000"
            route = request.scope.get("route")
            logging.getLogger("armeniabus.requests").info(
                "Request completed",
                extra={
                    "method": request.method,
                    "route": getattr(route, "path", "unmatched"),
                    "status_code": response.status_code,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 2),
                },
            )
            return response
        finally:
            request_id_context.reset(token)

    register_error_handlers(app)
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(web_auth_router)
    app.include_router(carriers_router)
    app.include_router(buses_router)
    app.include_router(routes_router)
    app.include_router(cities_router)
    app.include_router(bookings_router)
    app.include_router(payments_router)
    app.include_router(cabinets_router)
    app.include_router(admin_router)
    return app


app = create_app()
