import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from pwdlib import PasswordHash

from armeniabus.core.config import Settings

password_hashing = PasswordHash.recommended()
_dummy_password_hash = password_hashing.hash("never-a-real-account-password")


def hash_password(password: str) -> str:
    return password_hashing.hash(password)


def verify_password(password: str, stored_hash: str | None) -> bool:
    return password_hashing.verify(password, stored_hash or _dummy_password_hash)


def create_access_token(user_id: uuid.UUID, settings: Settings, auth_version: int = 0) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "typ": "access",
        "ver": auth_version,
        "jti": str(uuid.uuid4()),
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_ttl_minutes),
        "iss": "armeniabus",
        "aud": "armeniabus-api",
    }
    return jwt.encode(payload, settings.jwt_secret_key.get_secret_value(), algorithm="HS256")


def create_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def refresh_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
