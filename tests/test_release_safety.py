import json
from argparse import Namespace

import pytest

from scripts import release_deploy as deploy
from scripts import release_manifest as manifest

OLD = ["sha256:" + "1" * 64, "sha256:" + "2" * 64]
NEW = ["sha256:" + "3" * 64, "sha256:" + "4" * 64]
RELEASE = {
    "format": 1,
    "commit": "a" * 40,
    "api_image": NEW[0],
    "web_image": NEW[1],
    "schema_revision": "0010",
}


@pytest.mark.parametrize(
    "field,value",
    [
        ("api_image", "ghcr.io/example/api:latest"),
        ("web_image", "web:v1"),
        ("commit", "abc"),
        ("schema_revision", "head; echo secret"),
        ("format", 2),
    ],
)
def test_manifest_rejects_unpinned_or_invalid_release(field, value):
    with pytest.raises(ValueError):
        manifest.validate({**RELEASE, field: value})


def test_manifest_rejects_mixed_commits(monkeypatch):
    monkeypatch.setattr(
        manifest,
        "inspect",
        lambda image: {
            "Config": {"Labels": {"org.opencontainers.image.revision": "b" * 40}},
        },
    )
    with pytest.raises(ValueError, match="revision label"):
        manifest.create("api:v1", "web:v1", RELEASE["commit"])


def test_manifest_requires_digest_for_exact_repository():
    with pytest.raises(ValueError, match="published digest"):
        manifest.published_digest(
            "ghcr.io/example/api:v1",
            {
                "RepoDigests": ["ghcr.io/other/api@" + NEW[0]],
            },
        )


def test_lock_cannot_remove_another_operation_lock(tmp_path):
    path = tmp_path / "lock"
    with deploy.lock(path):
        with pytest.raises(FileExistsError), deploy.lock(path):
            pytest.fail("Second operation acquired the lock")
        assert path.exists()
    assert not path.exists()


def test_config_fingerprint_ignores_images_in_compose_extensions_but_keeps_environment():
    before = {
        "services": {"api": {"image": OLD[0], "environment": {"KEY": "one"}}},
        "x-app": {"image": OLD[0]},
    }
    after = {
        "services": {"api": {"image": NEW[0], "environment": {"KEY": "one"}}},
        "x-app": {"image": NEW[0]},
    }
    assert deploy.configuration_hash(before) == deploy.configuration_hash(after)
    after["services"]["api"]["environment"]["KEY"] = "two"
    assert deploy.configuration_hash(before) != deploy.configuration_hash(after)


@pytest.fixture
def operation(tmp_path, monkeypatch):
    events = []
    args = Namespace(
        project="test", state=tmp_path / "journal.json", env_file=tmp_path / "env", ca_file=None
    )

    class FakeDeployment:
        fingerprint = "hash"
        daemon = "daemon"
        image_ids = NEW
        fail = None
        revision_value = "0010"

        def __init__(self, *args):
            pass

        def preflight(self, *args):
            events.append("preflight")

        def current_images(self):
            return OLD

        def revision(self):
            return self.revision_value

        def stop(self):
            events.append("stop")

        def backup(self, revision):
            events.append("backup-and-restore-check")
            if self.fail == "backup":
                raise ValueError("Backup verification failed")
            return "backup.dump"

        def compose(self, *command):
            assert command[-2:] == ("upgrade", "0010")
            events.append("migrate")
            if self.fail == "migrate":
                raise ValueError("Migration failed")

        def start(self):
            events.append("start-and-https")

        def active_images(self):
            events.append("active-images")

        def check_rollback_target(self, state):
            events.append("rollback-guards")

    monkeypatch.setattr(deploy, "Deployment", FakeDeployment)
    return args, events, FakeDeployment


def test_update_backs_up_before_migration_and_records_recovery_state(operation):
    args, events, _ = operation
    deploy.apply(args, RELEASE)
    assert events == [
        "preflight",
        "stop",
        "backup-and-restore-check",
        "migrate",
        "start-and-https",
        "active-images",
    ]
    state = json.loads(args.state.read_text())
    assert state["old_images"] == OLD
    assert state["new_images"] == NEW
    assert state["phase"] == "complete"


@pytest.mark.parametrize("failure,phase", [("backup", "backup"), ("migrate", "migration")])
def test_failed_update_stays_stopped_without_automatic_rollback(operation, failure, phase):
    args, events, fake = operation
    fake.fail = failure
    with pytest.raises(ValueError):
        deploy.apply(args, RELEASE)
    assert "start-and-https" not in events
    assert events[-1] == "stop"
    if failure == "backup":
        assert "migrate" not in events
    assert json.loads(args.state.read_text())["phase"] == phase


def test_update_cannot_overwrite_an_existing_journal(operation):
    args, events, _ = operation
    args.state.write_text("existing")
    with pytest.raises(FileExistsError):
        deploy.apply(args, RELEASE)
    assert "stop" not in events
    assert args.state.read_text() == "existing"


def test_schema_change_refuses_code_rollback_before_stop(operation):
    args, events, fake = operation
    fake.revision_value = "0011"
    with pytest.raises(ValueError, match="Schema changed"):
        deploy.rollback(
            args, {"format": 1, "project": "test", "old_images": OLD, "before_revision": "0010"}
        )
    assert "stop" not in events


@pytest.mark.parametrize("changed", ["configuration", "daemon", "images"])
def test_rollback_rejects_changed_environment_or_obsolete_journal(tmp_path, changed):
    args = Namespace(project="test", env_file=tmp_path / "env")
    instance = deploy.Deployment(args, OLD)
    instance.fingerprint = "config"
    instance.daemon = "host"
    instance.compose = lambda *args: "container"
    instance.run = lambda command: json.dumps([{"Image": "sha256:" + "f" * 64}])
    state = {"configuration_hash": "config", "daemon": "host", "old_images": OLD, "new_images": NEW}
    if changed == "configuration":
        state["configuration_hash"] = "different"
    if changed == "daemon":
        state["daemon"] = "different"
    with pytest.raises(ValueError, match="changed|Obsolete"):
        instance.check_rollback_target(state)


def test_plan_does_not_run_commands_or_create_state(tmp_path, monkeypatch):
    env = tmp_path / "env"
    env.touch()
    release = tmp_path / "release.json"
    release.write_text(json.dumps(RELEASE))
    state = tmp_path / "journal.json"
    monkeypatch.setattr(
        "sys.argv",
        [
            "release_deploy",
            "apply",
            "--project",
            "test",
            "--env-file",
            str(env),
            "--manifest",
            str(release),
            "--state",
            str(state),
        ],
    )
    monkeypatch.setattr(deploy.subprocess, "check_output", lambda *a, **k: pytest.fail("Docker"))
    assert deploy.main() == 0
    assert not state.exists()
    assert not list(tmp_path.glob("*.lock"))


def test_apply_requires_manifest(tmp_path, monkeypatch):
    env = tmp_path / "env"
    env.touch()
    monkeypatch.setattr(
        "sys.argv",
        [
            "release_deploy",
            "apply",
            "--project",
            "test",
            "--env-file",
            str(env),
            "--state",
            str(tmp_path / "state"),
        ],
    )
    assert deploy.main() == 1
