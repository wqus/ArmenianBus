import asyncio
import json
import uuid

import httpx
import pytest

from armeniabus.core.config import Settings
from armeniabus.modules.payments.provider import ProviderError, YooKassa


def settings():
    return Settings(
        database_url="postgresql+asyncpg://test:test@localhost/armeniabus_test",
        redis_url="redis://localhost",
        jwt_secret_key="test-secret-at-least-32-characters",
        payments_enabled=True,
        yookassa_shop_id="123",
        yookassa_secret_key="test-key",
    )


def snapshot(external_id=None, **changes):
    return {
        "id": str(external_id or uuid.uuid4()),
        "status": "pending",
        "paid": False,
        "test": True,
        "amount": {"value": "4500.50", "currency": "RUB"},
        "recipient": {"account_id": "123"},
        "metadata": {},
        "confirmation": {"type": "redirect", "confirmation_url": "https://yoomoney.ru/test"},
        **changes,
    }


def test_provider_request_auth_idempotency_payload_and_safe_response():
    key = uuid.uuid4()
    response = snapshot(payment_method={"card": {"pan": "not-real-card-data"}})
    payload = {"amount": {"value": "4500.50", "currency": "RUB"}}

    def handle(request):
        assert request.url == "https://api.yookassa.ru/v3/payments"
        assert request.headers["Idempotence-Key"] == str(key)
        assert request.headers["Authorization"].startswith("Basic ")
        assert json.loads(request.content) == payload
        return httpx.Response(200, json=response)

    async def run():
        provider = YooKassa(settings(), httpx.MockTransport(handle))
        try:
            result = await provider.create(key, payload)
            assert str(result.amount.value) == "4500.50"
            assert "payment_method" not in result.model_dump()
        finally:
            await provider.close()

    asyncio.run(run())


@pytest.mark.parametrize(
    "status,code",
    [
        (400, "PROVIDER_REJECTED"),
        (401, "PROVIDER_UNAVAILABLE"),
        (429, "PROVIDER_UNAVAILABLE"),
        (500, "PROVIDER_UNAVAILABLE"),
        (302, "PROVIDER_UNAVAILABLE"),
    ],
)
def test_http_failures_do_not_expose_provider_body(status, code):
    async def run():
        provider = YooKassa(
            settings(),
            httpx.MockTransport(
                lambda request: httpx.Response(status, text="sensitive-provider-data")
            ),
        )
        try:
            with pytest.raises(ProviderError, match=code) as exc:
                await provider.create(uuid.uuid4(), {})
            assert "sensitive" not in str(exc.value)
        finally:
            await provider.close()

    asyncio.run(run())


def test_timeout_bad_json_and_mismatched_get_id_are_controlled():
    async def run():
        for mode in ("timeout", "json", "id"):

            def handle(request, mode=mode):
                if mode == "timeout":
                    raise httpx.ReadTimeout("secret request details")
                return (
                    httpx.Response(200, text="invalid")
                    if mode == "json"
                    else httpx.Response(200, json=snapshot())
                )

            provider = YooKassa(settings(), httpx.MockTransport(handle))
            try:
                with pytest.raises(ProviderError) as exc:
                    await provider.get(str(uuid.uuid4()))
                assert "secret" not in str(exc.value)
            finally:
                await provider.close()

    asyncio.run(run())
