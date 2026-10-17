"""Transfer a trusted workflow artifact over pinned SSH and run its deployment entry point."""

import argparse
import os
import re
import shlex
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

if __package__:
    from . import ci_deploy
else:
    import ci_deploy

BUNDLE_FILES = (
    "release.json",
    "compose.production.yaml",
    "compose.existing-nginx.yaml",
    "compose.pilot.yaml",
    "deploy/Caddyfile.behind-nginx",
    "deploy/init-app-db.sh",
    "scripts/release_deploy.py",
    "scripts/release_manifest.py",
    "scripts/database_backup.py",
    "scripts/ci_deploy.py",
)

# Bundle entries are allowlisted regular files with mode 644, without secrets.
# GNU tar otherwise masks these permissions with the SSH shell's private umask.
EXTRACT_COMMAND = 'tar --no-same-owner --same-permissions -xzf "$1" -C /opt/armeniabus/current'


def make_bundle(directory, destination):
    with tarfile.open(destination, "w:gz") as archive:
        for name in BUNDLE_FILES:
            path = directory / name
            if (
                path.is_symlink()
                or not path.is_file()
                or not path.resolve().is_relative_to(directory.resolve())
            ):
                raise ValueError("Release artifact is missing a regular required file")
            info = archive.gettarinfo(str(path), arcname=name)
            if not info.isfile():
                raise ValueError("Only regular files may enter the deployment bundle")
            info.mode = 0o644
            with path.open("rb") as stream:
                archive.addfile(info, stream)


def transfer(args):
    ci_deploy.validate_release(args.artifact, args.release_id, args.commit, args.repository.lower())
    host = os.environ.get("DEPLOY_HOST", "")
    user = os.environ.get("DEPLOY_USER", "")
    port = os.environ.get("DEPLOY_PORT") or "22"
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}", host):
        raise ValueError("Invalid SSH host")
    if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", user):
        raise ValueError("Invalid SSH username")
    if not port.isdigit() or not 1 <= int(port) <= 65535:
        raise ValueError("Invalid SSH port")
    token = os.environ.get("REGISTRY_TOKEN", "")
    registry_user = os.environ.get("REGISTRY_USER", "")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", registry_user):
        raise ValueError("Invalid registry username")
    if not token or len(token) > 4096 or any(char.isspace() for char in token):
        raise ValueError("Registry token is missing or malformed")
    with tempfile.TemporaryDirectory(prefix="armeniabus-ssh-") as directory:
        temporary = Path(directory)
        key = temporary / "identity"
        hosts = temporary / "known_hosts"
        for path, variable in ((key, "DEPLOY_SSH_PRIVATE_KEY"), (hosts, "DEPLOY_SSH_KNOWN_HOSTS")):
            value = os.environ.get(variable, "").replace("\r\n", "\n").strip()
            if not value:
                raise ValueError("SSH key and verified known_hosts are required")
            with path.open("w", encoding="utf-8", newline="\n") as stream:
                stream.write(value + "\n")
            path.chmod(0o600)
        bundle = temporary / "release.tar.gz"
        make_bundle(args.artifact, bundle)
        options = [
            "-i",
            str(key),
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            f"UserKnownHostsFile={hosts}",
            "-o",
            "ConnectTimeout=15",
        ]
        target = f"{user}@{host}"
        incoming = f"/opt/armeniabus/incoming/{args.release_id}.tar.gz"
        subprocess.run(
            ["scp", *options, "-P", port, str(bundle), f"{target}:{incoming}"], check=True
        )
        # Both the workflow concurrency group and this host lock serialize whole deployments,
        # including extraction into the stable bind-mount directory before Python takes its lock.
        program = (
            f"set -eu; umask 077; {EXTRACT_COMMAND}; "
            "exec python3 /opt/armeniabus/current/scripts/ci_deploy.py "
            '--release-id "$2" --commit "$3" --repository "$4" --registry-user "$5"'
        )
        command = shlex.join(
            [
                "flock",
                "-w",
                "120",
                "/opt/armeniabus/.ci-deploy.lock",
                "sh",
                "-c",
                program,
                "sh",
                incoming,
                args.release_id,
                args.commit,
                args.repository.lower(),
                registry_user,
            ]
        )
        # Keep the job-scoped GHCR token out of SSH arguments and the persistent server config.
        subprocess.run(
            ["ssh", *options, "-p", port, target, command],
            input=token + "\n",
            text=True,
            check=True,
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--repository", required=True)
    args = parser.parse_args()
    try:
        transfer(args)
    except (OSError, ValueError, TypeError, KeyError, subprocess.CalledProcessError) as error:
        if type(error) is ValueError:
            print(str(error), file=sys.stderr)
        print(f"SSH release failed ({type(error).__name__})", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
