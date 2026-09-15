from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = Field(min_length=1)
    redis_url: str = Field(min_length=1)
    cors_origins: list[str] = Field(default_factory=list)
    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()
