"""Binary-safe PostgreSQL backup and isolated restore drill via Docker Compose."""

import argparse
import hashlib
import json
import re
import subprocess
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

RESTORE_NAME = re.compile(r"armeniabus_[0-9a-f]{12}_restorecheck")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def command(args, script, *parameters, stdin=None, stdout=subprocess.PIPE):
    base = ["docker", "compose"]
    if args.project_name:
        base += ["--project-name", args.project_name]
    for compose in args.compose_file:
        base += ["-f", compose]
    if args.env_file:
        base += ["--env-file", args.env_file]
    return subprocess.run(
        base + ["exec", "-T", args.service, "sh", "-ec", script, "sh", *parameters],
        stdin=stdin,
        stdout=stdout,
        stderr=subprocess.PIPE,
        check=True,
    )


def backup(args):
    path = args.file.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation never overwrites an existing backup.
    with path.open("xb") as output:
        command(
            args,
            'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl',
            stdout=output,
        )
    manifest = {
        "created_at": datetime.now(UTC).isoformat(),
        "sha256": digest(path),
        "bytes": path.stat().st_size,
        "format": "pg_dump-custom",
        "service": args.service,
    }
    with Path(str(path) + ".json").open("x", encoding="utf-8") as output:
        json.dump(manifest, output, indent=2)
    print(json.dumps({"backup": str(path), **manifest}))


def restore_check(args):
    path = args.file.resolve()
    manifest = json.loads(Path(str(path) + ".json").read_text(encoding="utf-8"))
    if digest(path) != manifest["sha256"]:
        raise ValueError("Backup checksum mismatch")
    target = f"armeniabus_{uuid.uuid4().hex[:12]}_restorecheck"
    if not RESTORE_NAME.fullmatch(target):
        raise ValueError("Unsafe restore database name")
    created = False
    try:
        command(args, 'exec createdb -U "$POSTGRES_USER" -T template0 "$1"', target)
        created = True
        with path.open("rb") as source:
            command(
                args,
                'exec pg_restore -U "$POSTGRES_USER" -d "$1" '
                "--no-owner --no-acl --exit-on-error --single-transaction",
                target,
                stdin=source,
            )
        sql = """SELECT json_build_object(
            'revision', (SELECT version_num FROM alembic_version),
            'users', (SELECT count(*) FROM users),
            'bookings', (SELECT count(*) FROM bookings),
            'payments', (SELECT count(*) FROM payments),
            'refund_cases', (SELECT count(*) FROM refund_cases),
            'notifications', (SELECT count(*) FROM notifications),
            'invalid_constraints', (SELECT count(*) FROM pg_constraint WHERE NOT convalidated),
            'invalid_indexes', (SELECT count(*) FROM pg_index WHERE NOT indisvalid))"""
        result = command(
            args,
            'exec psql -X -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -At -c "$2"',
            target,
            sql,
        )
        report = json.loads(result.stdout)
        if report["invalid_constraints"] or report["invalid_indexes"]:
            raise ValueError("Restore contains invalid constraints or indexes")
        if args.expected_revision and report["revision"] != args.expected_revision:
            raise ValueError("Restored migration revision differs from expected revision")
    finally:
        # Only the freshly created isolated database is eligible for cleanup.
        if created and RESTORE_NAME.fullmatch(target):
            command(args, 'exec dropdb -U "$POSTGRES_USER" "$1"', target)
    print(json.dumps({"restore_check": "passed", "sha256": manifest["sha256"], **report}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("backup", "restore-check"))
    parser.add_argument("file", type=Path)
    parser.add_argument("--service", choices=("db", "db-test"), default="db")
    parser.add_argument("--compose-file", action="append", default=[])
    parser.add_argument("--env-file")
    parser.add_argument("--project-name")
    parser.add_argument("--expected-revision")
    args = parser.parse_args()
    try:
        (backup if args.action == "backup" else restore_check)(args)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as exc:
        # Do not echo subprocess output, which can contain connection details.
        print(f"Database operation failed: {type(exc).__name__}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
