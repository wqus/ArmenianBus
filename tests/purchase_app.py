"""Disposable browser acceptance server. Never included in the runtime image."""

import json
import os
import uuid
from contextlib import asynccontextmanager
from email import policy
from email.parser import BytesParser
from unittest.mock import patch

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, SecretStr
from sqlalchemy.engine import make_url

from armeniabus.core.config import Settings
from armeniabus.main import create_app
from armeniabus.modules.notifications.delivery import SmtpSender, deliver_batch
from armeniabus.modules.payments.provider import YooKassa
from tests.test_payment_provider import snapshot


def create_purchase_app():
    config = Settings()
    if (
        os.getenv("RUN_PURCHASE_E2E") != "1"
        or config.app_env != "development"
        or make_url(config.database_url).database != "armeniabus_test"
        or config.smtp_host != "smtp.invalid"
    ):
        raise RuntimeError("Purchase harness requires an explicit disposable test environment")
    config.payments_enabled = True
    config.yookassa_shop_id = "123"
    config.yookassa_secret_key = SecretStr("test-only-provider-key")
    config.yookassa_test_mode = True
    config.payment_return_url = "http://127.0.0.1:5174/payment/result"
    config.smtp_username = ""
    app = create_app(config)
    objects, creates, captured = {}, {}, []

    def provider_http(request):
        # Every YooKassa request terminates in this in-process HTTP boundary.
        if request.method == "POST":
            key = request.headers["Idempotence-Key"]
            payload = json.loads(request.content)
            if key not in creates:
                obj = snapshot(amount=payload["amount"], metadata=payload["metadata"])
                objects[obj["id"]] = obj
                creates[key] = obj["id"]
            return httpx.Response(200, json=objects[creates[key]])
        obj = objects.get(request.url.path.rsplit("/", 1)[-1])
        return httpx.Response(200, json=obj) if obj else httpx.Response(404)

    class Mailbox:
        def __init__(self, host, port, *, timeout, context):
            if host != "smtp.invalid" or not context.check_hostname:
                raise RuntimeError("Only the capture mailbox is allowed")

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def send_message(self, message):
            captured.append(
                BytesParser(policy=policy.default).parsebytes(message.as_bytes(policy=policy.SMTP))
            )
            return {}

    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(instance):
        async with original_lifespan(instance):
            await instance.state.payment_provider.close()
            instance.state.payment_provider = YooKassa(config, httpx.MockTransport(provider_http))
            yield

    app.router.lifespan_context = lifespan

    class Outcome(BaseModel):
        status: str

    @app.post("/_test/purchase/{booking_id}")
    async def complete(booking_id: uuid.UUID, data: Outcome):
        obj = next(
            (obj for obj in objects.values() if obj["metadata"]["booking_id"] == str(booking_id)),
            None,
        )
        if not obj or data.status not in {"succeeded", "canceled"}:
            raise HTTPException(400)
        obj.update(status=data.status, paid=data.status == "succeeded")
        # Invoke the public webhook endpoint; it must GET the verified object itself.
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            response = await client.post(
                "/api/v1/webhooks/payments",
                json={
                    "type": "notification",
                    "event": "payment." + data.status,
                    "object": {"id": obj["id"]},
                },
            )
            if response.status_code != 200:
                raise HTTPException(500, "Webhook acceptance failed")
        with patch("armeniabus.modules.notifications.delivery.smtplib.SMTP_SSL", Mailbox):
            await deliver_batch(app.state.db_sessions, SmtpSender(config), config)
        messages = [m for m in captured if str(booking_id) in m.get_content()]
        return {
            "provider_creates": sum(
                objects[value]["metadata"]["booking_id"] == str(booking_id)
                for value in creates.values()
            ),
            "messages": [
                {"to": str(m["To"]), "subject": str(m["Subject"]), "body": m.get_content()}
                for m in messages
            ],
        }

    return app
