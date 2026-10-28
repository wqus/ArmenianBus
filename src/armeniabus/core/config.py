from functools import lru_cache
from typing import Literal
from urllib.parse import urlsplit

from pydantic import EmailStr, Field, HttpUrl, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", hide_input_in_errors=True
    )

    database_url: str = Field(min_length=1)
    redis_url: str = Field(min_length=1)
    cors_origins: list[str] = Field(default_factory=list)
    log_level: str = "INFO"
    app_env: Literal["development", "production"] = "development"
    allowed_hosts: list[str] = Field(
        default_factory=lambda: ["localhost", "127.0.0.1", "testserver"]
    )
    request_max_bytes: int = Field(default=65536, ge=1024, le=1048576)
    request_body_timeout_seconds: int = Field(default=10, ge=1, le=60)
    worker_stale_seconds: int = Field(default=600, ge=30, le=7200)
    jwt_secret_key: SecretStr
    access_token_ttl_minutes: int = Field(default=15, ge=1, le=60)
    refresh_token_ttl_days: int = Field(default=30, ge=1, le=90)
    auth_rate_limit_per_minute: int = Field(default=10, ge=1, le=1000)
    booking_hold_minutes: int = Field(default=10, ge=1, le=60)
    hold_worker_interval_seconds: int = Field(default=5, ge=1, le=300)
    hold_worker_batch_size: int = Field(default=500, ge=1, le=5000)
    payments_enabled: bool = False
    yookassa_shop_id: str = ""
    yookassa_secret_key: SecretStr = SecretStr("")
    yookassa_test_mode: bool = True
    payment_return_url: HttpUrl = HttpUrl("http://localhost:5173/payment/result")
    payment_poll_seconds: int = Field(default=30, ge=5, le=300)
    payment_batch_size: int = Field(default=10, ge=1, le=100)
    paid_cancellation_cutoff_hours: int = Field(default=24, ge=0, le=720)
    notifications_enabled: bool = False
    auth_public_origin: HttpUrl | None = None
    smtp_host: str = ""
    smtp_port: int = Field(default=465, ge=1, le=65535)
    smtp_from: EmailStr | None = None
    smtp_username: str = ""
    smtp_password: SecretStr = SecretStr("")
    notification_batch_size: int = Field(default=20, ge=1, le=100)
    notification_poll_seconds: int = Field(default=5, ge=1, le=300)
    notification_retry_seconds: int = Field(default=30, ge=1, le=3600)
    notification_max_attempts: int = Field(default=8, ge=1, le=20)

    @field_validator("auth_public_origin", mode="before")
    @classmethod
    def optional_auth_origin(cls, value):
        return None if value == "" else value

    @model_validator(mode="after")
    def validate_jwt_secret(self):
        if len(self.jwt_secret_key.get_secret_value()) < 32:
            raise ValueError("JWT_SECRET_KEY must contain at least 32 characters")
        if self.payments_enabled:
            if not self.yookassa_shop_id or not self.yookassa_secret_key.get_secret_value():
                raise ValueError("Enabled payments require YooKassa shop ID and secret")
            if not self.yookassa_test_mode and self.payment_return_url.scheme != "https":
                raise ValueError("Live payments require an HTTPS return URL")
        if self.notifications_enabled and (not self.smtp_host or not self.smtp_from):
            raise ValueError("Enabled notifications require SMTP_HOST and SMTP_FROM")
        if self.auth_public_origin:
            parsed = urlsplit(str(self.auth_public_origin))
            if (
                parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
                or parsed.path not in {"", "/"}
            ):
                raise ValueError("AUTH_PUBLIC_ORIGIN must be an exact origin")
        if self.notifications_enabled and self.app_env == "production":
            origin = self.auth_public_origin or self.payment_return_url
            if origin.scheme != "https" or origin.username or origin.password:
                raise ValueError("Account emails require a trusted HTTPS public origin")
        if not self.allowed_hosts or any(not host or "/" in host for host in self.allowed_hosts):
            raise ValueError("ALLOWED_HOSTS must contain hostnames")
        if self.app_env == "production":
            secret = self.jwt_secret_key.get_secret_value()
            if len(secret) < 64 or len(set(secret)) < 16 or "replace-this" in secret:
                raise ValueError(
                    "Production requires a fresh random JWT secret of at least 64 characters"
                )
            if any("*" in host for host in self.allowed_hosts) or not any(
                host not in {"localhost", "127.0.0.1", "testserver"} for host in self.allowed_hosts
            ):
                raise ValueError("Production requires explicit public ALLOWED_HOSTS")
            for origin in self.cors_origins:
                parsed = urlsplit(origin)
                if (
                    parsed.scheme != "https"
                    or not parsed.hostname
                    or parsed.username
                    or parsed.path
                    or parsed.query
                    or parsed.fragment
                    or "*" in origin
                ):
                    raise ValueError("Production CORS origins must be exact HTTPS origins")
            password = make_url(self.database_url).password or ""
            if len(password) < 24 or password == "change-me-local":
                raise ValueError(
                    "Production requires a non-default database password of at least 24 characters"
                )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
