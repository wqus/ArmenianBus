from functools import lru_cache

from pydantic import Field, HttpUrl, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = Field(min_length=1)
    redis_url: str = Field(min_length=1)
    cors_origins: list[str] = Field(default_factory=list)
    log_level: str = "INFO"
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

    @model_validator(mode="after")
    def validate_jwt_secret(self):
        if len(self.jwt_secret_key.get_secret_value()) < 32:
            raise ValueError("JWT_SECRET_KEY must contain at least 32 characters")
        if self.payments_enabled:
            if not self.yookassa_shop_id or not self.yookassa_secret_key.get_secret_value():
                raise ValueError("Enabled payments require YooKassa shop ID and secret")
            if not self.yookassa_test_mode and self.payment_return_url.scheme != "https":
                raise ValueError("Live payments require an HTTPS return URL")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
