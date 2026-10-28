import uuid

import pytest
from pydantic import ValidationError

from armeniabus.core.config import Settings
from armeniabus.modules.users.actions import action_token, public_origin, token_hash


def settings(**values):
    return Settings(
        database_url="postgresql+asyncpg://user:password@db/test",
        redis_url="redis://redis/0",
        jwt_secret_key="test-only-action-secret-of-at-least-32-characters",
        **values,
    )


def test_capabilities_have_separate_purposes_and_only_hashes_are_persisted():
    action_id = uuid.uuid4()
    config = settings()
    reset = action_token(action_id, "RESET", config)
    verify = action_token(action_id, "VERIFY", config)
    assert len(reset) == 97 and reset != verify
    assert reset == action_token(action_id, "RESET", config)
    assert len(token_hash(reset)) == 64 and token_hash(reset) != reset


@pytest.mark.parametrize(
    "origin",
    [
        "https://site.test/path",
        "https://site.test/?token=secret",
        "https://site.test/#secret",
        "https://user:password@site.test",
    ],
)
def test_public_origin_cannot_include_credentials_paths_or_tokens(origin):
    with pytest.raises(ValidationError):
        settings(auth_public_origin=origin)


def test_mail_origin_comes_from_explicit_configuration_not_http_host():
    assert (
        public_origin(settings(payment_return_url="https://bus.example.com/payment/result"))
        == "https://bus.example.com"
    )
    assert (
        public_origin(settings(auth_public_origin="https://pilot.example.com:8443"))
        == "https://pilot.example.com:8443"
    )
