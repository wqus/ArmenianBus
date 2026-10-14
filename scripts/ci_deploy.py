"""Server-side entry point for a trusted release bundle; credentials arrive on stdin."""

import argparse
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

if __package__:
    from . import release_manifest
else:
    import release_manifest

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "armeniabus"
RELEASE_ID = re.compile(r"([0-9a-f]{40})-[1-9][0-9]*-[1-9][0-9]*")
REPOSITORY = re.compile(r"[a-z0-9][a-z0-9_-]*/[a-z0-9][a-z0-9_.-]*")


def validate_release(directory, release_id, commit, repository):
    match = RELEASE_ID.fullmatch(release_id)
    if not match or match[1] != commit or not REPOSITORY.fullmatch(repository):
        raise ValueError("Invalid release identity")
    manifest = release_manifest.validate(json.loads((directory / "release.json").read_text()))
    if manifest["commit"] != commit:
        raise ValueError("Manifest commit differs from the workflow commit")
    for service in ("api", "web"):
        if not manifest[f"{service}_image"].startswith(f"ghcr.io/{repository}/{service}@sha256:"):
            raise ValueError("Manifest image belongs to another registry or repository")
    return manifest


def check_state(directory, release_id):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    for path in directory.glob("*.json"):
        if path.name.endswith(".dump.json"):
            continue
        value = json.loads(path.read_text())
        if (
            not isinstance(value, dict)
            or value.get("format") != 1
            or value.get("project") != PROJECT
        ):
            raise ValueError("Unrecognized deployment journal")
        if value.get("phase") not in {"complete", "rolled_back"}:
            raise ValueError(
                "An incomplete deployment needs operator recovery before another release"
            )
    target = directory / f"{release_id}.json"
    if target.exists():
        raise ValueError("This release attempt already has a journal; do not overwrite it")
    return target


def deploy(release_id, commit, repository, registry_user, token):
    validate_release(ROOT, release_id, commit, repository)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", registry_user):
        raise ValueError("Invalid registry username")
    if not token or len(token) > 4096 or any(char.isspace() for char in token):
        raise ValueError("A registry token must arrive through stdin")
    env_file = ROOT.parent / "shared/production.env"
    if not env_file.is_file() or stat.S_IMODE(env_file.stat().st_mode) & 0o077:
        raise ValueError("Server env-file must exist and have permissions 600 or stricter")
    profile = (ROOT.parent / "shared/deployment-profile").read_text().strip()
    if profile not in {"pilot", "production"}:
        raise ValueError("Server deployment-profile must contain pilot or production")
    state = check_state(ROOT.parent / "release-state/production", release_id)
    # The server env-file is authoritative. Drop inherited APP/POSTGRES/SMTP variables.
    environment = {key: os.environ[key] for key in ("PATH", "HOME", "LANG") if key in os.environ}
    extra = []
    if profile == "pilot":
        environment["YOOKASSA_TEST_MODE"] = "true"
        extra = [
            "--compose-override",
            str(ROOT / "compose.pilot.yaml"),
            "--min-available-mib",
            "896",
        ]
    with tempfile.TemporaryDirectory(prefix="armeniabus-registry-") as directory:
        environment["DOCKER_CONFIG"] = directory
        subprocess.run(
            ["docker", "login", "ghcr.io", "--username", registry_user, "--password-stdin"],
            input=token + "\n",
            text=True,
            env=environment,
            capture_output=True,
            check=True,
        )
        containers = subprocess.check_output(
            [
                "docker",
                "ps",
                "-a",
                "--filter",
                f"label=com.docker.compose.project={PROJECT}",
                "--format",
                "{{.ID}}",
            ],
            env=environment,
            stderr=subprocess.PIPE,
            text=True,
        ).strip()
        action = "apply" if containers else "init"
        print(f"Automatic deployment: {action} {release_id}", flush=True)
        subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/release_deploy.py"),
                action,
                "--project",
                PROJECT,
                "--env-file",
                str(env_file),
                "--compose-override",
                str(ROOT / "compose.existing-nginx.yaml"),
                *extra,
                "--manifest",
                str(ROOT / "release.json"),
                "--state",
                str(state),
                "--execute",
            ],
            cwd=ROOT,
            env=environment,
            check=True,
        )
        identifiers = subprocess.check_output(
            [
                "docker",
                "ps",
                "--filter",
                f"label=com.docker.compose.project={PROJECT}",
                "--format",
                "{{.ID}}",
            ],
            env=environment,
            stderr=subprocess.PIPE,
            text=True,
        ).split()
        if identifiers:
            subprocess.run(
                [
                    "docker",
                    "stats",
                    "--no-stream",
                    "--format",
                    "table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}",
                    *identifiers,
                ],
                env=environment,
                check=True,
            )
    print("Automatic deployment completed", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--registry-user", required=True)
    args = parser.parse_args()
    try:
        token = sys.stdin.readline(4098).strip()
        deploy(args.release_id, args.commit, args.repository.lower(), args.registry_user, token)
    except (OSError, ValueError, TypeError, KeyError, subprocess.CalledProcessError) as error:
        if type(error) is ValueError:
            print(str(error), file=sys.stderr)
        print(f"Automatic deployment failed ({type(error).__name__})", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
