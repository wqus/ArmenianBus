import json
import smtplib
import ssl
from unittest.mock import MagicMock

import httpx
import pytest
from pydantic import SecretStr

from armeniabus import integration_check as probe
from armeniabus.core.config import Settings


@pytest.fixture
def settings():
    return Settings(
        _env_file=None,
        app_env="production",
        database_url="postgresql://app:" + "a" * 32 + "@db/staging",
        redis_url="redis://redis/0",
        jwt_secret_key="0123456789abcdef" * 4,
        allowed_hosts=["staging.example.com"],
        cors_origins=["https://staging.example.com"],
        payment_return_url="https://staging.example.com/payment/result",
        yookassa_shop_id="12345",
        yookassa_secret_key="private-shop-secret",
        yookassa_test_mode=True,
        payments_enabled=False,
        notifications_enabled=False,
        smtp_host="smtp.example.com",
        smtp_from="sender@example.com",
        smtp_username="sender",
        smtp_password="private-smtp-secret",
    )


def test_offline_does_not_connect_even_with_valid_credentials(settings, monkeypatch):
    for name in ("shop_check", "smtp_check", "site_check"):
        monkeypatch.setattr(probe, name, lambda *a: pytest.fail("Unexpected network access"))
    report = probe.check(settings)
    assert all(x["status"] == "passed" for x in report["checks"][:5])
    assert all(x["status"] == "not_checked" for x in report["checks"][5:])
    assert report["scope"] == "configuration_only"
    assert report["acceptance_complete"] is False
    assert "private-" not in json.dumps(report)


@pytest.mark.parametrize(
    "change",
    [
        {"app_env": "development"},
        {"yookassa_test_mode": False},
        {"yookassa_secret_key": SecretStr("")},
        {"smtp_password": SecretStr("")},
        {"cors_origins": ["https://other.example.com"]},
        {"allowed_hosts": ["other.example.com"]},
    ],
)
def test_invalid_configuration_blocks_all_network(settings, monkeypatch, change):
    for name in ("shop_check", "smtp_check", "site_check"):
        monkeypatch.setattr(probe, name, lambda *a: pytest.fail("Unexpected network access"))
    report = probe.check(settings.model_copy(update=change), network=True)
    assert any(x["status"] == "blocked" for x in report["checks"])


def shop_response(**changes):
    return {
        "account_id": "12345",
        "test": True,
        "status": "enabled",
        "payment_methods": ["bank_card"],
        **changes,
    }


@pytest.mark.parametrize(
    "body,code",
    [
        (shop_response(), "TEST_SHOP_ACCESS_VERIFIED"),
        (
            shop_response(fiscalization={"enabled": False, "provider": "atol"}),
            "TEST_SHOP_ACCESS_VERIFIED",
        ),
        (shop_response(account_id="999"), "SHOP_ID_MISMATCH"),
        (shop_response(test=False), "TEST_SHOP_NOT_CONFIRMED"),
        (shop_response(test="true"), "TEST_SHOP_NOT_CONFIRMED"),
        (shop_response(status="disabled"), "SHOP_NOT_ENABLED"),
        (shop_response(fiscalization={"enabled": True}), "RECEIPT_SUPPORT_NOT_IMPLEMENTED"),
        (shop_response(fiscalization_enabled=True), "RECEIPT_SUPPORT_NOT_IMPLEMENTED"),
        (shop_response(fiscalization={"enabled": "false"}), "SHOP_INVALID_RESPONSE"),
        (shop_response(fiscalization_enabled="false"), "SHOP_INVALID_RESPONSE"),
    ],
)
def test_shop_is_read_only_and_checks_identity_mode_and_receipts(settings, body, code):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(200, json=body)

    report = probe.shop_check(settings, httpx.MockTransport(respond))
    assert report["code"] == code
    assert len(calls) == 1
    assert calls[0].method == "GET"
    assert str(calls[0].url) == "https://api.yookassa.ru/v3/me"
    assert calls[0].headers["authorization"].startswith("Basic ")


@pytest.mark.parametrize("status", [302, 401, 403, 429, 500])
def test_provider_error_or_redirect_never_leaks_response_or_credentials(settings, status):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(
            status,
            text="private-provider-response",
            headers={"location": "https://other.example.com"},
        )

    report = probe.shop_check(settings, httpx.MockTransport(respond))
    assert report["status"] == "blocked"
    assert "private" not in json.dumps(report)
    assert len(calls) == 1


def test_shop_timeout_is_sanitized(settings):
    def respond(request):
        raise httpx.ReadTimeout("private-shop-secret")

    report = probe.shop_check(settings, httpx.MockTransport(respond))
    assert report["status"] == "blocked"
    assert "private" not in json.dumps(report)


@pytest.mark.parametrize("failure", [None, "login", "tls", "noop"])
def test_smtp_uses_verified_tls_and_never_sends_mail(settings, monkeypatch, failure):
    factory = MagicMock()
    smtp = factory.return_value.__enter__.return_value
    smtp.ehlo.return_value = (250, b"ok")
    smtp.noop.return_value = (250, b"ok")
    if failure == "login":
        smtp.login.side_effect = smtplib.SMTPAuthenticationError(535, b"private-smtp-secret")
    elif failure == "tls":
        factory.side_effect = ssl.SSLCertVerificationError("private-host")
    elif failure == "noop":
        smtp.noop.return_value = (421, b"private-response")
    monkeypatch.setattr(probe.smtplib, "SMTP_SSL", factory)
    report = probe.smtp_check(settings)
    context = factory.call_args.kwargs["context"]
    assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
    assert report["status"] == ("blocked" if failure else "passed")
    assert "private" not in json.dumps(report)
    smtp.sendmail.assert_not_called()
    smtp.send_message.assert_not_called()
    smtp.mail.assert_not_called()
    smtp.rcpt.assert_not_called()
    smtp.data.assert_not_called()


@pytest.mark.parametrize("status,body", [(200, {"status": "ok"}), (200, {}), (503, {})])
def test_https_requires_real_readiness(settings, status, body):
    def respond(request):
        assert request.method == "GET"
        assert str(request.url) == "https://staging.example.com/api/v1/health/ready"
        return httpx.Response(status, json=body)

    report = probe.site_check(settings, httpx.MockTransport(respond))
    assert (report["status"] == "passed") == (body == {"status": "ok"} and status == 200)


def test_successful_network_check_does_not_claim_acceptance(settings, monkeypatch):
    for name in ("shop_check", "smtp_check", "site_check"):
        monkeypatch.setattr(probe, name, lambda *a: probe.result("remote", True, "OK"))
    assert probe.check(settings, network=True)["acceptance_complete"] is False


def test_invalid_environment_has_no_traceback_or_secret(monkeypatch, capsys):
    monkeypatch.setenv("CORS_ORIGINS", "private-invalid-json")
    assert probe.main([]) == 1
    output = capsys.readouterr()
    assert "INVALID_SETTINGS" in output.out
    assert "private" not in output.out + output.err
