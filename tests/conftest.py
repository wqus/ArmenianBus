import os

import pytest
from sqlalchemy.engine import make_url


@pytest.fixture(scope="session", autouse=True)
def require_isolated_database():
    if os.getenv("RUN_DB_TESTS") == "1":
        database = make_url(os.environ["DATABASE_URL"]).database or ""
        if not database.endswith("_test"):
            pytest.fail("Database tests require an isolated database ending in _test")
