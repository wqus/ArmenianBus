from fastapi.testclient import TestClient

from armeniabus.core.config import Settings
from armeniabus.main import create_app


def test_login_fails_closed_when_rate_limiter_is_unavailable():
    app = create_app(
        Settings(
            database_url="postgresql+asyncpg://user:password@127.0.0.1:1/missing",
            redis_url="redis://127.0.0.1:1/0",
            jwt_secret_key="auth-error-test-secret-at-least-32-characters",
        )
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/auth/login",
            json={"email": "absent@example.com", "password": "invalid"},
        )
        assert response.status_code == 503
        assert response.json()["code"] == "DEPENDENCY_UNAVAILABLE"
        assert response.json()["request_id"] == response.headers["X-Request-ID"]
