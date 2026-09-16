from datetime import datetime, timedelta

from armeniabus.modules.routes.models import RouteStatus


def paid_cancellation_allowed(
    route_status: str, departure_at: datetime, now: datetime, cutoff_hours: int
) -> bool:
    return (
        route_status == RouteStatus.ACTIVE
        and departure_at > now
        and departure_at - now >= timedelta(hours=cutoff_hours)
    )
