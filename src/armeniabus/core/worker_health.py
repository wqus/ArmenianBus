"""Heartbeat rules shared by the dashboard and the lightweight container probe."""

from datetime import timedelta

WORKERS = ("holds", "payments", "notifications")


def heartbeat_state(*, last_seen_at, last_error, enabled, now, stale_seconds):
    if last_seen_at < now - timedelta(seconds=stale_seconds):
        return "STALE"
    if last_error:
        return "ERROR"
    return "OK" if enabled else "DISABLED"
