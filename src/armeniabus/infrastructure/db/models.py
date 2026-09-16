"""Register the full metadata graph for migrations and non-HTTP processes."""

from armeniabus.modules.admin import models as admin_models  # noqa: F401
from armeniabus.modules.bookings import models as booking_models  # noqa: F401
from armeniabus.modules.buses import models as bus_models  # noqa: F401
from armeniabus.modules.carriers import models as carrier_models  # noqa: F401
from armeniabus.modules.notifications import models as notification_models  # noqa: F401
from armeniabus.modules.payments import models as payment_models  # noqa: F401
from armeniabus.modules.payments import refunds  # noqa: F401
from armeniabus.modules.routes import models as route_models  # noqa: F401
from armeniabus.modules.users import models as user_models  # noqa: F401
