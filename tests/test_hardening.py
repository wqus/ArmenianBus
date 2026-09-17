import asyncio
import json
import logging
import sys

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from pydantic import ValidationError

from armeniabus.api.body_limit import BodyLimitMiddleware
from armeniabus.core.config import Settings
from armeniabus.core.logging import JsonFormatter
from armeniabus.main import create_app


def settings(**overrides):
    return Settings(
        _env_file=None,
        **{
            "database_url": "postgresql+asyncpg://user:0123456789abcdef0123456789abcdef@localhost/missing",
            "redis_url": "redis://localhost:6379/0",
            "jwt_secret_key": "0123456789abcdef" * 4,
            "allowed_hosts": ["api.example.com", "testserver"],
            "cors_origins": ["https://example.com"],
            **overrides,
        },
    )


def test_production_headers_hosts_and_private_documentation():
    with TestClient(create_app(settings(app_env="production"))) as client:
        response = client.get("/api/v1/health/live", headers={"X-Request-ID": "unsafe request id"})
        assert response.status_code == 200
        assert response.headers["x-request-id"] != "unsafe request id"
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["x-frame-options"] == "DENY"
        assert response.headers["strict-transport-security"] == "max-age=31536000"
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(path).status_code == 404
        assert (
            client.get("/api/v1/health/live", headers={"Host": "attacker.example"}).status_code
            == 400
        )


@pytest.mark.parametrize(
    "override",
    [
        {"jwt_secret_key": "not-a-production-secret-32-characters"},
        {"jwt_secret_key": "a" * 64},
        {"allowed_hosts": ["*"]},
        {"allowed_hosts": ["localhost"]},
        {"cors_origins": ["http://example.com"]},
        {"cors_origins": ["https://example.com/path"]},
        {"database_url": "postgresql+asyncpg://user:short@localhost/db"},
    ],
)
def test_production_rejects_unsafe_configuration(override):
    with pytest.raises(ValidationError):
        settings(app_env="production", **override)


def test_body_limits_preserve_json_and_correlation():
    app = create_app(settings(request_max_bytes=1024))

    @app.post("/echo")
    async def echo(request: Request):
        return await request.json()

    with TestClient(app) as client:
        assert client.post("/echo", json={"hello": "world"}).json() == {"hello": "world"}
        response = client.post(
            "/echo",
            content=b"x" * 1025,
            headers={"X-Request-ID": "large-1", "Origin": "https://example.com"},
        )
        assert response.status_code == 413
        assert response.json()["code"] == "REQUEST_TOO_LARGE"
        assert response.headers["access-control-allow-origin"] == "https://example.com"
        assert response.json()["request_id"] == response.headers["x-request-id"] == "large-1"
        assert client.post("/echo", headers={"Content-Length": "invalid"}).status_code == 400


@pytest.mark.parametrize("slow,expected", [(False, 413), (True, 408)])
def test_chunked_body_limit_and_slow_client(slow, expected):
    async def scenario():
        messages = []

        async def downstream(scope, receive, send):
            pytest.fail("Oversized or stalled body reached the application")

        async def receive():
            if slow:
                await asyncio.sleep(1)
            return {"type": "http.request", "body": b"x" * 700, "more_body": True}

        async def send(message):
            messages.append(message)

        middleware = BodyLimitMiddleware(downstream, max_bytes=1024, timeout_seconds=0.01)
        await middleware(
            {"type": "http", "headers": [], "state": {"request_id": "chunked"}}, receive, send
        )
        assert messages[0]["status"] == expected
        assert json.loads(messages[1]["body"])["request_id"] == "chunked"

    asyncio.run(scenario())


def test_exception_logs_do_not_serialize_exception_values_or_source():
    try:
        raise ValueError("secret-token-and-private-email@example.com")
    except ValueError:
        record = logging.LogRecord(
            "test", logging.ERROR, __file__, 1, "Operation failed", (), sys.exc_info()
        )
    output = JsonFormatter().format(record)
    assert "secret-token" not in output
    assert "raise ValueError" not in output
    assert json.loads(output)["error_type"] == "ValueError"
    assert json.loads(output)["frames"]


def test_request_logs_use_route_template_without_query_or_identifier(capsys):
    app = create_app(settings())

    @app.get("/probe/{identifier}")
    async def probe(identifier: str):
        return {"ok": True}

    with TestClient(app) as client:
        assert client.get("/probe/private-id?token=private-token").status_code == 200
    output = capsys.readouterr().err
    assert '"route": "/probe/{identifier}"' in output
    assert "private-id" not in output
    assert "private-token" not in output
