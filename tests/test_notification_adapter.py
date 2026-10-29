import smtplib
import uuid
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from unittest.mock import patch

import pytest

from armeniabus.core.config import Settings
from armeniabus.modules.bookings.policy import paid_cancellation_allowed
from armeniabus.modules.notifications.delivery import SmtpSender
from armeniabus.modules.notifications.models import Notification


def test_paid_cancellation_exact_deadline_and_departed_route():
    now = datetime(2026, 9, 16, tzinfo=UTC)
    assert paid_cancellation_allowed("ACTIVE", now + timedelta(hours=24), now, 24)
    assert not paid_cancellation_allowed(
        "ACTIVE", now + timedelta(hours=24, microseconds=-1), now, 24
    )
    assert not paid_cancellation_allowed("ACTIVE", now, now, 0)
    assert not paid_cancellation_allowed("DEPARTED", now + timedelta(days=2), now, 24)


def test_smtp_uses_verified_tls_and_stable_message_id_without_network():
    settings = Settings(
        _env_file=None,
        database_url="unused",
        redis_url="unused",
        jwt_secret_key="x" * 32,
        notifications_enabled=True,
        smtp_host="smtp.invalid",
        smtp_from="sender@example.com",
        smtp_username="sender",
        smtp_password="test-secret",
    )
    item = Notification(
        id=uuid.uuid4(),
        recipient_email="recipient@example.com",
        subject="Оплата подтверждена",
        body="Поездка в Гюмри",
    )
    with patch("armeniabus.modules.notifications.delivery.smtplib.SMTP_SSL") as smtp_class:
        smtp = smtp_class.return_value.__enter__.return_value
        smtp.send_message.return_value = {}
        sender = SmtpSender(settings)
        sender._send(item)
        sender._send(item)
        context = smtp_class.call_args.kwargs["context"]
        assert context.check_hostname
        messages = [call.args[0] for call in smtp.send_message.call_args_list]
        assert messages[0]["Message-ID"] == messages[1]["Message-ID"] == f"<{item.id}@example.com>"
        assert messages[0]["To"] == "recipient@example.com"
        assert parsedate_to_datetime(messages[0]["Date"]).utcoffset() == timedelta(0)
        assert "Гюмри" in messages[0].get_content()
        smtp.login.assert_called_with("sender", "test-secret")
        smtp.send_message.return_value = {"recipient@example.com": (550, b"refused")}
        with pytest.raises(smtplib.SMTPRecipientsRefused):
            sender._send(item)


def test_enabled_notifications_require_delivery_configuration():
    with pytest.raises(ValueError, match="SMTP_HOST and SMTP_FROM"):
        Settings(
            _env_file=None,
            database_url="unused",
            redis_url="unused",
            jwt_secret_key="x" * 32,
            notifications_enabled=True,
        )
