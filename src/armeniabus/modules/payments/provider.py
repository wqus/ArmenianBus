import uuid
from decimal import Decimal
from typing import Literal

import httpx
from pydantic import BaseModel, Field, HttpUrl, StrictBool, ValidationError

from armeniabus.core.config import Settings


class ProviderError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class Amount(BaseModel):
    value: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    currency: str


class Recipient(BaseModel):
    account_id: str


class Confirmation(BaseModel):
    type: str
    confirmation_url: HttpUrl | None = None


class ProviderPayment(BaseModel):
    id: uuid.UUID
    status: Literal["pending", "waiting_for_capture", "succeeded", "canceled"]
    amount: Amount
    paid: StrictBool
    test: StrictBool
    recipient: Recipient
    metadata: dict[str, str] = Field(default_factory=dict)
    confirmation: Confirmation | None = None


class YooKassa:
    def __init__(self, settings: Settings, transport=None):
        self.settings = settings
        self.client = httpx.AsyncClient(
            base_url="https://api.yookassa.ru/v3/",
            auth=(settings.yookassa_shop_id, settings.yookassa_secret_key.get_secret_value()),
            timeout=httpx.Timeout(10, connect=5),
            follow_redirects=False,
            transport=transport,
        )

    async def close(self):
        await self.client.aclose()

    async def _request(self, method, path, **kwargs) -> ProviderPayment:
        if not self.settings.payments_enabled:
            raise ProviderError("PAYMENTS_DISABLED")
        try:
            response = await self.client.request(method, path, **kwargs)
        except httpx.HTTPError:
            raise ProviderError("PROVIDER_UNAVAILABLE") from None
        if method == "POST" and response.status_code in (400, 422):
            raise ProviderError("PROVIDER_REJECTED")
        if response.status_code == 404:
            raise ProviderError("PROVIDER_NOT_FOUND")
        if response.status_code not in (200, 201):
            raise ProviderError("PROVIDER_UNAVAILABLE")
        try:
            return ProviderPayment.model_validate(response.json())
        except (ValidationError, ValueError):
            raise ProviderError("PROVIDER_INVALID_RESPONSE") from None

    async def create(self, key: uuid.UUID, payload: dict) -> ProviderPayment:
        return await self._request(
            "POST", "payments", headers={"Idempotence-Key": str(key)}, json=payload
        )

    async def get(self, external_id: str) -> ProviderPayment:
        # Parse before interpolating so notification IDs cannot alter the API URL.
        safe_id = str(uuid.UUID(external_id))
        result = await self._request("GET", f"payments/{safe_id}")
        if str(result.id) != safe_id:
            raise ProviderError("PROVIDER_INVALID_RESPONSE")
        return result
