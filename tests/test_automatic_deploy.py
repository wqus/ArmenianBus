import json
import os
import shlex
import subprocess
import sys
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import ci_deploy, prepare_ci_vps, release_deploy, ssh_release

COMMIT = "a" * 40
RELEASE_ID = COMMIT + "-123-1"
REPOSITORY = "wqus/armenianbus"
TOKEN = "test-token-never-print"
MANIFEST = {
    "format": 1,
    "commit": COMMIT,
    "schema_revision": "0010",
    "api_image": f"ghcr.io/{REPOSITORY}/api@sha256:" + "1" * 64,
    "web_image": f"ghcr.io/{REPOSITORY}/web@sha256:" + "2" * 64,
}


@pytest.fixture
def artifact(tmp_path):
    directory = tmp_path / "artifact"
    directory.mkdir()
    for name in ssh_release.BUNDLE_FILES:
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture", encoding="utf-8")
    (directory / "release.json").write_text(json.dumps(MANIFEST), encoding="utf-8")
    return directory


@pytest.mark.parametrize(
    "field,value",
    [
        ("commit", "b" * 40),
        ("api_image", "ghcr.io/other/project/api@sha256:" + "1" * 64),
        ("web_image", "ghcr.io/wqus/armenianbus/web:latest"),
    ],
)
def test_wrong_commit_or_repository_is_rejected(artifact, field, value):
    (artifact / "release.json").write_text(json.dumps({**MANIFEST, field: value}))
    with pytest.raises(ValueError):
        ci_deploy.validate_release(artifact, RELEASE_ID, COMMIT, REPOSITORY)


def test_bundle_contains_no_env_credentials_or_unrelated_files(artifact, tmp_path):
    (artifact / "production.env").write_text(TOKEN)
    (artifact / "unrelated.py").write_text("danger")
    output = tmp_path / "bundle.tar.gz"
    ssh_release.make_bundle(artifact, output)
    with tarfile.open(output) as archive:
        assert set(archive.getnames()) == set(ssh_release.BUNDLE_FILES)
        assert all(item.isfile() and item.mode == 0o644 for item in archive.getmembers())


def test_bundle_refuses_symlink_instead_of_deployment_script(artifact, tmp_path):
    outside = tmp_path / "outside"
    outside.write_text(TOKEN)
    path = artifact / "scripts/ci_deploy.py"
    path.unlink()
    try:
        path.symlink_to(outside)
    except OSError:
        pytest.skip("Symlink creation is unavailable on this platform")
    with pytest.raises(ValueError):
        ssh_release.make_bundle(artifact, tmp_path / "bundle.tar.gz")


@pytest.mark.skipif(os.name == "nt", reason="Requires Unix permission and umask semantics")
def test_extracted_bind_mount_files_remain_readable_under_private_umask(artifact, tmp_path):
    bundle = tmp_path / "bundle.tar.gz"
    ssh_release.make_bundle(artifact, bundle)
    target = tmp_path / "current"
    target.mkdir(mode=0o700)
    command = ssh_release.EXTRACT_COMMAND.replace(
        "/opt/armeniabus/current", shlex.quote(str(target))
    )
    subprocess.run(["sh", "-c", f"umask 077; {command}", "sh", str(bundle)], check=True)
    assert target.stat().st_mode & 0o777 == 0o700
    for name in ssh_release.BUNDLE_FILES:
        assert (target / name).stat().st_mode & 0o777 == 0o644


@pytest.fixture
def ssh_arguments(artifact, monkeypatch):
    values = {
        "DEPLOY_HOST": "95.81.100.204",
        "DEPLOY_USER": "armeniabus-ci",
        "DEPLOY_PORT": "22",
        "DEPLOY_SSH_PRIVATE_KEY": "fixture-private-key",
        "DEPLOY_SSH_KNOWN_HOSTS": "fixture-pinned-host-key",
        "REGISTRY_USER": "wqus",
        "REGISTRY_TOKEN": TOKEN,
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    return SimpleNamespace(
        artifact=artifact, release_id=RELEASE_ID, commit=COMMIT, repository=REPOSITORY
    )


def test_ssh_pins_host_and_sends_token_only_on_stdin(ssh_arguments, monkeypatch):
    calls = []
    private_paths = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        private_paths.append(Path(command[command.index("-i") + 1]))
        assert private_paths[-1].read_text().strip() == "fixture-private-key"

    monkeypatch.setattr(ssh_release.subprocess, "run", run)
    ssh_release.transfer(ssh_arguments)
    assert [command[0] for command, _ in calls] == ["scp", "ssh"]
    for command, _ in calls:
        assert "StrictHostKeyChecking=yes" in command
        assert any(part.startswith("UserKnownHostsFile=") for part in command)
        assert "IdentitiesOnly=yes" in command
        assert TOKEN not in " ".join(command)
    assert calls[-1][1]["input"] == TOKEN + "\n"
    assert "flock" in calls[-1][0][-1]
    assert not any(path.exists() for path in private_paths)


@pytest.mark.parametrize(
    "variable,value",
    [
        ("DEPLOY_HOST", "host; touch /tmp/danger"),
        ("DEPLOY_USER", "root -oProxyCommand=danger"),
        ("DEPLOY_PORT", "99999"),
        ("DEPLOY_SSH_KNOWN_HOSTS", ""),
    ],
)
def test_bad_ssh_configuration_never_connects(ssh_arguments, monkeypatch, variable, value):
    monkeypatch.setenv(variable, value)
    monkeypatch.setattr(ssh_release.subprocess, "run", lambda *a, **k: pytest.fail("Connected"))
    with pytest.raises(ValueError):
        ssh_release.transfer(ssh_arguments)


def test_failed_copy_never_runs_remote_deployment(ssh_arguments, monkeypatch):
    commands = []

    def fail(command, **kwargs):
        commands.append(command)
        raise subprocess.CalledProcessError(1, command)

    monkeypatch.setattr(ssh_release.subprocess, "run", fail)
    with pytest.raises(subprocess.CalledProcessError):
        ssh_release.transfer(ssh_arguments)
    assert len(commands) == 1 and commands[0][0] == "scp"


def test_incomplete_release_blocks_next_automatic_deployment(tmp_path):
    (tmp_path / "prior.json").write_text(
        json.dumps(
            {
                "format": 1,
                "project": "armeniabus",
                "phase": "migration",
            }
        )
    )
    with pytest.raises(ValueError, match="operator recovery"):
        ci_deploy.check_state(tmp_path, RELEASE_ID)


def test_backup_metadata_does_not_block_next_release(tmp_path):
    (tmp_path / "prior.json").write_text(
        json.dumps(
            {
                "format": 1,
                "project": "armeniabus",
                "phase": "complete",
            }
        )
    )
    (tmp_path / "prior.dump.json").write_text(json.dumps({"sha256": "fixture", "bytes": 123}))
    assert ci_deploy.check_state(tmp_path, RELEASE_ID) == tmp_path / (RELEASE_ID + ".json")


@pytest.fixture
def server(artifact, monkeypatch):
    shared = artifact.parent / "shared"
    shared.mkdir()
    env = shared / "production.env"
    env.write_text("secret-only-on-server")
    env.chmod(0o600)
    (shared / "deployment-profile").write_text("pilot")
    monkeypatch.setattr(ci_deploy, "ROOT", artifact)
    if os.name == "nt":
        # Windows ACLs are not POSIX mode bits. Server-side ownership is checked on Linux.
        monkeypatch.setattr(ci_deploy, "stat", SimpleNamespace(S_IMODE=lambda _: 0o600))
    return artifact


@pytest.mark.parametrize("existing,action", [("", "init"), ("existing-container", "apply")])
def test_server_selects_init_or_update_and_uses_temporary_registry_login(
    server,
    monkeypatch,
    existing,
    action,
):
    calls = []
    monkeypatch.setenv("POSTGRES_PASSWORD", "must-not-override-server-env")

    def run(command, **kwargs):
        calls.append((command, kwargs))
        assert "POSTGRES_PASSWORD" not in kwargs["env"]
        assert TOKEN not in " ".join(command)

    monkeypatch.setattr(ci_deploy.subprocess, "run", run)
    monkeypatch.setattr(ci_deploy.subprocess, "check_output", lambda *a, **k: existing)
    ci_deploy.deploy(RELEASE_ID, COMMIT, REPOSITORY, "wqus", TOKEN)
    login, release = calls[:2]
    assert login[1]["input"] == TOKEN + "\n"
    assert "--password-stdin" in login[0]
    assert release[0][2] == action
    assert release[0].count("--compose-override") == 2
    assert "896" in release[0]
    assert release[1]["env"]["YOOKASSA_TEST_MODE"] == "true"
    assert not Path(login[1]["env"]["DOCKER_CONFIG"]).exists()


def test_registry_login_failure_never_invokes_deploy(server, monkeypatch):
    commands = []

    def fail(command, **kwargs):
        commands.append(command)
        raise subprocess.CalledProcessError(1, command, stderr=TOKEN)

    monkeypatch.setattr(ci_deploy.subprocess, "run", fail)
    with pytest.raises(subprocess.CalledProcessError):
        ci_deploy.deploy(RELEASE_ID, COMMIT, REPOSITORY, "wqus", TOKEN)
    assert len(commands) == 1 and commands[0][1] == "login"


def test_low_memory_refuses_first_installation(monkeypatch):
    monkeypatch.setattr(Path, "read_text", lambda *a, **k: "MemAvailable: 512000 kB\n")
    with pytest.raises(ValueError, match="No application containers started"):
        release_deploy.check_available_memory(896)


def test_memory_wait_accepts_recovery_without_lowering_threshold(monkeypatch, capsys):
    samples = iter((894, 895, 931))
    clock = [0]
    sleeps = []

    def sleep(seconds):
        sleeps.append(seconds)
        clock[0] += seconds

    monkeypatch.setattr(
        Path, "read_text", lambda *a, **k: f"MemAvailable: {next(samples) * 1024} kB\n"
    )
    monkeypatch.setattr(release_deploy.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(release_deploy.time, "sleep", sleep)
    release_deploy.check_available_memory(896, timeout_seconds=180)
    assert sleeps == [10, 10]
    assert "931 MiB available" in capsys.readouterr().out


def test_backup_keeps_both_ingress_and_pilot_overlays(tmp_path):
    ingress, pilot = tmp_path / "ingress.yaml", tmp_path / "pilot.yaml"
    args = SimpleNamespace(
        project="test",
        state=tmp_path / "journal.json",
        env_file=tmp_path / "env",
        compose_override=[ingress, pilot],
    )
    deployment = release_deploy.Deployment(args, [MANIFEST["api_image"], MANIFEST["web_image"]])
    calls = []
    deployment.run = lambda command: calls.append(command) or ""
    deployment.backup("0010")
    for command in calls:
        assert str(ingress) in command and str(pilot) in command


@pytest.mark.parametrize(
    "networks,routes",
    [
        ([{"IPAM": {"Config": [{"Subnet": "172.30.0.0/16"}]}}], []),
        ([], [{"dst": "172.30.10.64/26"}]),
    ],
)
def test_setup_refuses_docker_and_vpn_subnet_collisions(networks, routes):
    with pytest.raises(ValueError, match="overlaps"):
        prepare_ci_vps.check_subnets(networks, routes)


def test_setup_allows_unrelated_networks_and_default_routes():
    prepare_ci_vps.check_subnets(
        [{"IPAM": {"Config": [{"Subnet": "172.18.0.0/16"}]}}],
        [{"dst": "default"}, {"dst": "0.0.0.0/0"}, {"dst": "10.0.0.0/8"}],
    )


def test_https_wait_retries_transient_dns_failure(monkeypatch):
    calls = []

    def smoke(*args):
        calls.append(args)
        if len(calls) < 3:
            raise OSError("Temporary DNS failure")

    monkeypatch.setattr(release_deploy, "https_smoke", smoke)
    monkeypatch.setattr(release_deploy.time, "sleep", lambda _: None)
    release_deploy.wait_for_https("https://bus.mathbot.site")
    assert len(calls) == 3


def test_https_wait_never_bypasses_certificate_verification(monkeypatch):
    def smoke(*args):
        raise release_deploy.ssl.SSLCertVerificationError("Wrong certificate")

    monkeypatch.setattr(release_deploy, "https_smoke", smoke)
    monkeypatch.setattr(release_deploy.time, "sleep", lambda _: pytest.fail("Retry"))
    with pytest.raises(release_deploy.ssl.SSLCertVerificationError):
        release_deploy.wait_for_https("https://bus.mathbot.site")


@pytest.fixture
def setup_server(tmp_path, monkeypatch):
    base = tmp_path / "vps"
    home = tmp_path / "home"
    public_key = tmp_path / "actions.pub"
    public_key.write_text("ssh-ed25519 AAAA fixture")
    monkeypatch.setattr(prepare_ci_vps, "BASE", base)
    account = SimpleNamespace(pw_uid=12345, pw_gid=12345, pw_dir=str(home))
    monkeypatch.setitem(sys.modules, "pwd", SimpleNamespace(getpwnam=lambda _: account))
    monkeypatch.setattr(
        prepare_ci_vps,
        "os",
        SimpleNamespace(
            name="posix",
            geteuid=lambda: 0,
            chown=lambda *a: None,
            O_CREAT=os.O_CREAT,
            O_EXCL=os.O_EXCL,
            O_WRONLY=os.O_WRONLY,
            open=os.open,
            fdopen=os.fdopen,
        ),
    )
    commands = []
    monkeypatch.setattr(prepare_ci_vps.subprocess, "run", lambda args, **kw: commands.append(args))

    def output(command):
        if command[:3] == ["docker", "network", "ls"]:
            return "network-id"
        if command[:3] == ["docker", "network", "inspect"]:
            return json.dumps([{"IPAM": {"Config": [{"Subnet": "172.18.0.0/16"}]}}])
        if command[0] == "ip":
            return '[{"dst": "default"}]'
        if command[:2] == ["docker", "inspect"]:
            return '{"nginx-proxy": {"IPAddress": "172.18.0.5"}}'
        if command[0] == "ssh-keygen":
            return "fixture-fingerprint"
        pytest.fail("Unexpected external command")

    monkeypatch.setattr(prepare_ci_vps, "output", output)
    return base, home, public_key, commands


def test_one_time_setup_generates_private_secrets_without_printing_them(setup_server, capsys):
    base, home, public_key, commands = setup_server
    prepare_ci_vps.prepare(public_key)
    values = dict(
        line.split("=", 1) for line in (base / "shared/production.env").read_text().splitlines()
    )
    output = capsys.readouterr().out
    for name in ("POSTGRES_PASSWORD", "POSTGRES_APP_PASSWORD", "JWT_SECRET_KEY"):
        assert len(values[name]) >= 64
        assert values[name] not in output
    assert values["POSTGRES_PASSWORD"] != values["POSTGRES_APP_PASSWORD"]
    assert values["PAYMENTS_ENABLED"] == values["NOTIFICATIONS_ENABLED"] == "false"
    assert (base / "shared/deployment-profile").read_text().strip() == "pilot"
    assert (home / ".ssh/authorized_keys").read_text().startswith("restrict ssh-ed25519 ")
    assert commands == [["usermod", "-aG", "docker", "armeniabus-ci"]]


def test_setup_never_overwrites_existing_env_with_new_passwords(setup_server):
    base, _, public_key, _ = setup_server
    shared = base / "shared"
    shared.mkdir(parents=True)
    env = shared / "production.env"
    env.write_text("existing-secret-must-survive")
    # Fixture account deliberately differs from the actual file owner.
    with pytest.raises(ValueError, match="ownership"):
        prepare_ci_vps.prepare(public_key)
    assert env.read_text() == "existing-secret-must-survive"


def test_setup_refuses_private_key_input_before_creating_account(setup_server):
    base, _, public_key, commands = setup_server
    public_key.write_text("-----BEGIN OPENSSH PRIVATE KEY-----")
    with pytest.raises(ValueError, match="public key"):
        prepare_ci_vps.prepare(public_key)
    assert not base.exists()
    assert commands == []
