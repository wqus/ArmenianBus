import uuid
from urllib.parse import parse_qs, urlsplit

from armeniabus.modules.payments.service import booking_return_url


def test_return_url_binds_booking_without_client_input_and_preserves_configured_query():
    booking_id = uuid.uuid4()
    result = urlsplit(
        booking_return_url(
            "https://example.com/payment/result?lang=ru&booking=old&booking=other#ignored",
            booking_id,
        )
    )
    assert result.scheme == "https"
    assert result.netloc == "example.com"
    assert result.path == "/payment/result"
    assert parse_qs(result.query) == {"lang": ["ru"], "booking": [str(booking_id)]}
    assert result.fragment == ""
