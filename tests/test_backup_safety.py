import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest

from scripts import database_backup


def arguments(path):
    return argparse.Namespace(file=path, expected_revision="0010", service="db-test")


def test_backup_refuses_overwrite_without_touching_database(tmp_path, monkeypatch):
    path = tmp_path / "existing.dump"
    path.write_bytes(b"original backup")
    command = Mock()
    monkeypatch.setattr(database_backup, "command", command)
    with pytest.raises(FileExistsError):
        database_backup.backup(arguments(path))
    command.assert_not_called()
    assert path.read_bytes() == b"original backup"


def test_corrupt_archive_is_rejected_before_creating_database(tmp_path, monkeypatch):
    path = tmp_path / "corrupt.dump"
    path.write_bytes(b"modified")
    Path(str(path) + ".json").write_text(json.dumps({"sha256": "wrong"}))
    command = Mock()
    monkeypatch.setattr(database_backup, "command", command)
    with pytest.raises(ValueError, match="checksum"):
        database_backup.restore_check(arguments(path))
    command.assert_not_called()


@pytest.mark.parametrize("creation_failed", [False, True])
def test_failed_restore_cleans_up_only_database_it_created(tmp_path, monkeypatch, creation_failed):
    path = tmp_path / "backup.dump"
    path.write_bytes(b"sample")
    Path(str(path) + ".json").write_text(
        json.dumps({"sha256": hashlib.sha256(b"sample").hexdigest()})
    )
    calls = []

    def command(args, script, *parameters, **kwargs):
        calls.append((script, parameters))
        if (creation_failed and "createdb" in script) or "pg_restore" in script:
            raise subprocess.CalledProcessError(1, "docker")

    monkeypatch.setattr(database_backup, "command", command)
    with pytest.raises(subprocess.CalledProcessError):
        database_backup.restore_check(arguments(path))
    target = calls[0][1][0]
    assert database_backup.RESTORE_NAME.fullmatch(target)
    assert all(parameters == (target,) for _, parameters in calls)
    if creation_failed:
        assert len(calls) == 1
    else:
        assert "dropdb" in calls[-1][0]
