"""Exit nonzero when a worker heartbeat is missing, stale, or failed."""

import argparse
import asyncio
import os

import asyncpg
from dotenv import load_dotenv

from armeniabus.core.worker_health import WORKERS, heartbeat_state


async def check(name):
    # Avoid loading FastAPI, Pydantic and the ORM in a second process inside a
    # CPU/memory-limited worker. The database heartbeat remains authoritative.
    load_dotenv(".env")
    url = os.environ["DATABASE_URL"]
    if not url.startswith("postgresql+asyncpg://"):
        raise ValueError("Expected the application asyncpg database URL")
    stale_seconds = int(os.environ.get("WORKER_STALE_SECONDS", "600"))
    if not 30 <= stale_seconds <= 7200:
        raise ValueError("Invalid heartbeat age limit")
    connection = await asyncpg.connect(url.replace("postgresql+asyncpg://", "postgresql://", 1))
    try:
        row = await connection.fetchrow(
            "SELECT last_seen_at, last_error, enabled, clock_timestamp() AS now "
            "FROM worker_heartbeats WHERE name = $1",
            name,
        )
        state = (
            "MISSING" if row is None else heartbeat_state(**dict(row), stale_seconds=stale_seconds)
        )
        print(f"{name}: {state}")
        return 0 if state in {"OK", "DISABLED"} else 1
    finally:
        await connection.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("worker", choices=WORKERS)
    args = parser.parse_args()
    try:
        raise SystemExit(asyncio.run(asyncio.wait_for(check(args.worker), timeout=5)))
    except Exception as exc:
        print(f"Worker check unavailable: {type(exc).__name__}")
        raise SystemExit(1) from None
