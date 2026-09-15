from fastapi.testclient import TestClient

from armeniabus.core.config import Settings
from armeniabus.main import create_app


def test_health_and_request_correlation():
    app = create_app(
        Settings(
            database_url="postgresql+asyncpg://user:password@localhost/missing",
            redis_url="redis://localhost:6379/0",
        )
    )
    with TestClient(app) as client:
        response = client.get("/api/v1/health/live", headers={"X-Request-ID": "test-123"})
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
        assert response.headers["X-Request-ID"] == "test-123"


def test_readiness_fails_closed_without_database():
    app = create_app(
        Settings(
            database_url="postgresql+asyncpg://user:password@127.0.0.1:1/missing",
            redis_url="redis://127.0.0.1:1/0",
        )
    )
    with TestClient(app) as client:
        response = client.get("/api/v1/health/ready")
        assert response.status_code == 503
        assert response.json()["code"] == "DEPENDENCY_UNAVAILABLE"
        assert response.json()["request_id"] == response.headers["X-Request-ID"]


def test_unhandled_errors_have_safe_public_shape_and_request_id():
    app = create_app(
        Settings(
            database_url="postgresql+asyncpg://user:password@localhost/missing",
            redis_url="redis://localhost:6379/0",
        )
    )

    @app.get("/test-error")
    async def fail():
        raise RuntimeError("private detail")

    with TestClient(app) as client:
        response = client.get("/test-error")
        assert response.status_code == 500
        assert response.json()["code"] == "INTERNAL_ERROR"
        assert "private detail" not in response.text
        assert response.json()["request_id"] == response.headers["X-Request-ID"]
