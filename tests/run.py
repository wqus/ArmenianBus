"""Migrate the isolated test database, then execute integration tests."""

import os
import subprocess
import sys

from sqlalchemy.engine import make_url

if __name__ == "__main__":
    database = make_url(os.environ["DATABASE_URL"]).database or ""
    if not database.endswith("_test"):
        raise SystemExit("Test runner requires a database name ending in _test")
    result = subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], check=False)
    if result.returncode:
        raise SystemExit(result.returncode)
    raise SystemExit(
        subprocess.call(
            [
                sys.executable,
                "-m",
                "pytest",
                "-q",
                "-p",
                "no:cacheprovider",
            ]
        )
    )
