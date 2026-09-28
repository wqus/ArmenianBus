"""Read-only staging checks. Never create payments, send mail, or modify the database."""

import argparse
import json
import smtplib
import ssl
from urllib.parse import urlsplit

import httpx
from pydantic import ValidationError
from pydantic_settings.exceptions import SettingsError

from armeniabus.core.config import Settings


def result(name, ok, code):
    return {"check": name, "status": "passed" if ok else "blocked", "code": code}


def configuration_checks(settings):
    url = urlsplit(str(settings.payment_return_url))
    origin = f"{url.scheme}://{url.netloc}"
    same_origin = (
        url.scheme == "https"
        and not url.username
        and not url.password
        and settings.cors_origins == [origin]
        and url.hostname in settings.allowed_hosts
        and url.path == "/payment/result"
        and not url.query
        and not url.fragment
    )
    credentials = bool(settings.yookassa_shop_id.strip()) and bool(
        settings.yookassa_secret_key.get_secret_value().strip()
    )
    smtp = bool(settings.smtp_host.strip() and settings.smtp_from) and (
        bool(settings.smtp_username) == bool(settings.smtp_password.get_secret_value())
    )
    return [
        result("environment", settings.app_env == "production", "HARDENED_ENV_REQUIRED"),
        result("return_url", bool(same_origin), "EXACT_HTTPS_SITE_REQUIRED"),
        result("payment_mode", settings.yookassa_test_mode, "TEST_SHOP_REQUIRED"),
        result("payment_credentials", bool(credentials), "SHOP_CREDENTIALS_REQUIRED"),
        result("smtp_configuration", smtp, "SMTP_CONFIGURATION_REQUIRED"),
    ]


def shop_check(settings, transport=None):
    # Fixed destination, verified TLS, no redirects or ambient proxy credentials.
    try:
        with httpx.Client(
            base_url="https://api.yookassa.ru/v3/",
            auth=(settings.yookassa_shop_id, settings.yookassa_secret_key.get_secret_value()),
            timeout=httpx.Timeout(10, connect=5),
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        ) as client:
            response = client.get("me")
        if response.status_code in (401, 403):
            return result("shop", False, "SHOP_ACCESS_DENIED")
        if response.status_code != 200:
            return result("shop", False, "SHOP_UNAVAILABLE")
        value = response.json()
        if not isinstance(value, dict) or value.get("account_id") != settings.yookassa_shop_id:
            return result("shop", False, "SHOP_ID_MISMATCH")
        if value.get("test") is not True:
            return result("shop", False, "TEST_SHOP_NOT_CONFIRMED")
        if value.get("status") != "enabled":
            return result("shop", False, "SHOP_NOT_ENABLED")
        # Current API uses fiscalization; the legacy boolean remains in older responses.
        fiscalization = value.get("fiscalization")
        if fiscalization is not None:
            if (
                not isinstance(fiscalization, dict)
                or type(fiscalization.get("enabled")) is not bool
            ):
                return result("shop", False, "SHOP_INVALID_RESPONSE")
            receipt_enabled = fiscalization["enabled"]
        else:
            receipt_enabled = value.get("fiscalization_enabled", False)
            if type(receipt_enabled) is not bool:
                return result("shop", False, "SHOP_INVALID_RESPONSE")
        if receipt_enabled:
            return result("shop", False, "RECEIPT_SUPPORT_NOT_IMPLEMENTED")
        return result("shop", True, "TEST_SHOP_ACCESS_VERIFIED")
    except (httpx.HTTPError, ValueError):
        return result("shop", False, "SHOP_CONNECTION_OR_RESPONSE_FAILED")


def smtp_check(settings):
    try:
        with smtplib.SMTP_SSL(
            settings.smtp_host,
            settings.smtp_port,
            timeout=10,
            context=ssl.create_default_context(),
        ) as smtp:
            if smtp.ehlo()[0] != 250:
                return result("smtp", False, "SMTP_EHLO_FAILED")
            if settings.smtp_username:
                smtp.login(settings.smtp_username, settings.smtp_password.get_secret_value())
            if smtp.noop()[0] != 250:
                return result("smtp", False, "SMTP_NOOP_FAILED")
        return result("smtp", True, "SMTP_CONNECTION_VERIFIED_NO_MAIL_SENT")
    except (smtplib.SMTPException, OSError):
        # Provider errors may include addresses, credentials and response text.
        return result("smtp", False, "SMTP_CONNECTION_OR_AUTH_FAILED")


def site_check(settings, transport=None):
    try:
        with httpx.Client(
            timeout=10, follow_redirects=False, trust_env=False, transport=transport
        ) as client:
            response = client.get(settings.cors_origins[0] + "/api/v1/health/ready")
        ok = response.status_code == 200 and response.json() == {"status": "ok"}
        return result("https", ok, "HTTPS_READY" if ok else "HTTPS_NOT_READY")
    except (httpx.HTTPError, ValueError):
        return result("https", False, "HTTPS_CONNECTION_OR_RESPONSE_FAILED")


def check(settings, network=False):
    checks = configuration_checks(settings)
    if network and all(item["status"] == "passed" for item in checks):
        checks.extend([shop_check(settings), smtp_check(settings), site_check(settings)])
    else:
        for name in ("shop", "smtp", "https"):
            checks.append({"check": name, "status": "not_checked", "code": "NETWORK_NOT_RUN"})
    return {
        "scope": "staging_connectivity" if network else "configuration_only",
        "checks": checks,
        "payments_enabled": settings.payments_enabled,
        "notifications_enabled": settings.notifications_enabled,
        "acceptance_complete": False,
        "pending_acceptance": ["real_test_payment_and_webhook", "mail_delivery_to_test_inbox"],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--network",
        action="store_true",
        help="GET shop settings/readiness and check SMTP TLS/auth; no mail sent",
    )
    args = parser.parse_args(argv)
    try:
        report = check(Settings(), network=args.network)
    except (ValidationError, SettingsError, OSError):
        # Never print validation inputs or the raw effective environment.
        print(
            json.dumps(
                {
                    "checks": [result("settings", False, "INVALID_SETTINGS")],
                    "acceptance_complete": False,
                }
            )
        )
        return 1
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return int(any(item["status"] == "blocked" for item in report["checks"]))


if __name__ == "__main__":
    raise SystemExit(main())
