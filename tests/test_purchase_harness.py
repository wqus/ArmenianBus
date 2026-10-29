import pytest

from armeniabus.core.config import Settings
from tests.purchase_app import create_purchase_app


@pytest.mark.parametrize("unsafe", ["flag", "production", "database", "smtp"])
def test_purchase_harness_refuses_non_disposable_environments(monkeypatch, unsafe):
    config = Settings(
        _env_file=None,
        database_url="postgresql+asyncpg://user:password@db-test/armeniabus_test",
        redis_url="redis://redis-test",
        jwt_secret_key="test-harness-secret-at-least-32-characters",
        smtp_host="smtp.invalid",
    )
    monkeypatch.setenv("RUN_PURCHASE_E2E", "1")
    if unsafe == "flag":
        monkeypatch.delenv("RUN_PURCHASE_E2E")
    elif unsafe == "production":
        config.app_env = "production"
    elif unsafe == "database":
        config.database_url = "postgresql+asyncpg://user:password@db/production"
    else:
        config.smtp_host = "smtp.example.com"
    monkeypatch.setattr("tests.purchase_app.Settings", lambda: config)
    with pytest.raises(RuntimeError, match="disposable test environment"):
        create_purchase_app()
