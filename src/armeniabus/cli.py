"""Local administrative commands. Passwords are never command-line arguments."""

import argparse
import asyncio
import getpass
import sys

from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError

from armeniabus.api.errors import ApiError
from armeniabus.core.config import get_settings
from armeniabus.infrastructure.db.session import create_session_factory
from armeniabus.modules.admin.service import AdminCreate, create_admin


async def provision_admin(data: AdminCreate) -> str:
    engine, sessions = create_session_factory(get_settings().database_url)
    try:
        async with sessions() as db:
            admin = await create_admin(db, data)
            return str(admin.id)
    finally:
        await engine.dispose()


def main() -> int:
    parser = argparse.ArgumentParser(description="armatrans administrative tools")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-admin", help="Create a new administrator")
    create.add_argument("--email", required=True)
    create.add_argument("--password-stdin", action="store_true", help="Read password from stdin")
    args = parser.parse_args()
    try:
        if args.password_stdin:
            password = sys.stdin.readline().rstrip("\r\n")
        else:
            password = getpass.getpass("Password (12–128 characters): ")
            if password != getpass.getpass("Repeat password: "):
                print("Passwords do not match", file=sys.stderr)
                return 1
        data = AdminCreate(email=args.email, password=password)
        admin_id = asyncio.run(provision_admin(data))
    except ValidationError:
        print("Use a valid email and a password of 12–128 characters", file=sys.stderr)
        return 1
    except ApiError as exc:
        print(exc.message, file=sys.stderr)
        return 1
    except SQLAlchemyError:
        print("Database operation failed; check connectivity and migrations", file=sys.stderr)
        return 1
    print(f"Administrator created: {admin_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
