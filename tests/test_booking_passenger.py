import uuid

import pytest
from pydantic import ValidationError

from armeniabus.modules.bookings.schemas import BookingCreate


def payload(**changes):
    return (
        dict(
            route_id=uuid.uuid4(),
            seat_id=uuid.uuid4(),
            passenger_first_name="  Արամ  ",
            passenger_last_name="Петросян-Саркисян",
            passenger_phone="+374 (99) 123-456",
        )
        | changes
    )


def test_passenger_names_and_phone_are_normalized_without_losing_native_script():
    value = BookingCreate(**payload())
    assert value.passenger_first_name == "Արամ"
    assert value.passenger_last_name == "Петросян-Саркисян"
    assert value.passenger_phone == "+37499123456"
    assert (
        BookingCreate(**payload(passenger_first_name="Jose\u0301")).passenger_first_name == "José"
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"passenger_first_name": "   "},
        {"passenger_first_name": "123"},
        {"passenger_last_name": "А\nБ"},
        {"passenger_last_name": "А\u200bБ"},
        {"passenger_last_name": "А" * 101},
        {"passenger_phone": "89991234567"},
        {"passenger_phone": "+0123456789"},
        {"passenger_phone": "+374123"},
        {"passenger_phone": "+1234567890123456"},
        {"passenger_phone": "+٣٧٤٩٩١٢٣٤٥٦"},
        {"passenger_phone": "+37499123456\r\nBcc: test@example.com"},
        {"passenger_phone": "+374++99123456"},
    ],
)
def test_invalid_passenger_data_is_rejected(changes):
    with pytest.raises(ValidationError):
        BookingCreate(**payload(**changes))


def test_identity_and_contact_are_required_for_new_bookings():
    with pytest.raises(ValidationError):
        BookingCreate(route_id=uuid.uuid4(), seat_id=uuid.uuid4())
