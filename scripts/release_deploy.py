"""First installation and maintenance-window updates; no database downgrade or restore."""

import argparse
import contextlib
import hashlib
import http.client
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

if __package__:
    from . import release_manifest
else:
    import release_manifest

ROOT = Path(__file__).resolve().parents[1]
WRITERS = ["api", "worker", "payment-worker", "notification-worker"]


def compose_overrides(args):
    value = args.compose_override
    return value if isinstance(value, list) else [value] if value else []


def check_available_memory(minimum_mib, timeout_seconds=0):
    if not minimum_mib:
        return
    deadline = time.monotonic() + timeout_seconds
    waiting = False
    while True:
        fields = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        available_mib = int(fields["MemAvailable"].split()[0]) // 1024
        if available_mib >= minimum_mib:
            if waiting:
                print(f"Memory check passed: {available_mib} MiB available", flush=True)
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError(
                f"First installation needs at least {minimum_mib} MiB available; "
                f"currently {available_mib} MiB. No application containers started."
            )
        if not waiting:
            print(
                f"Waiting up to {timeout_seconds}s for {minimum_mib} MiB available; "
                f"currently {available_mib} MiB. No application containers started.",
                flush=True,
            )
            waiting = True
        time.sleep(min(10, remaining))


def configuration_hash(configuration):
    # Compose preserves x-* authoring extensions as well as expanded services.
    # Hash only effective configuration, excluding the intentionally replaced images.
    fingerprint = json.loads(
        json.dumps({key: value for key, value in configuration.items() if not key.startswith("x-")})
    )
    for service in fingerprint["services"].values():
        service.pop("image", None)
        service.pop("build", None)
    return hashlib.sha256(json.dumps(fingerprint, sort_keys=True).encode()).hexdigest()


def save(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
    temporary.replace(path)


@contextlib.contextmanager
def lock(path):
    # An abandoned lock requires operator inspection, never automatic removal.
    with path.open("x", encoding="utf-8") as stream:
        stream.write(str(os.getpid()))
    try:
        yield
    finally:
        path.unlink()


def rollback_allowed(state, revision):
    if revision != state["before_revision"]:
        raise ValueError(
            "Schema changed: automatic code rollback refused; use the recovery runbook"
        )


def https_smoke(origin, ca_file=None):
    url = urlsplit(origin)
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.path
        or url.query
        or url.fragment
    ):
        raise ValueError("Smoke requires an exact HTTPS origin")
    context = ssl.create_default_context(cafile=ca_file)
    for path in ("/api/v1/health/ready", "/"):
        connection = http.client.HTTPSConnection(
            url.hostname, url.port or 443, context=context, timeout=10
        )
        # Reserved loopback name used by the isolated drill; retain TLS hostname verification.
        if url.hostname.endswith(".localhost"):
            connection.sock = context.wrap_socket(
                socket.create_connection(("127.0.0.1", url.port or 443), timeout=10),
                server_hostname=url.hostname,
            )
        try:
            connection.request(
                "GET", path, headers={"User-Agent": "ArmeniaBus-Deployment-Check/1.0"}
            )
            response = connection.getresponse()
            body = response.read(2_000_000)
            if response.status != 200:
                raise ValueError(f"Public HTTPS smoke failed ({path}: HTTP {response.status})")
            if path == "/" and b'<div id="root">' not in body:
                raise ValueError("Frontend response is not the release application")
            if path != "/" and json.loads(body) != {"status": "ok"}:
                raise ValueError("Public API readiness failed")
        finally:
            connection.close()


def wait_for_https(origin, ca_file=None):
    # Existing Nginx caches Docker DNS briefly, including negative answers on a first boot.
    for attempt in range(6):
        try:
            https_smoke(origin, ca_file)
            return
        except ssl.SSLCertVerificationError:
            raise
        except (OSError, ValueError, http.client.HTTPException):
            if attempt == 5:
                raise
            time.sleep(2)


class Deployment:
    def __init__(self, args, images):
        self.args = args
        self.env = {
            **os.environ,
            "APP_IMAGE": images[0],
            "WEB_IMAGE": images[1],
            "COMPOSE_PROFILES": "",
        }
        self.base = [
            "docker",
            "compose",
            "-p",
            args.project,
            "-f",
            str(ROOT / "compose.production.yaml"),
        ]
        for override in compose_overrides(args):
            self.base += ["-f", str(override)]
        self.base += ["--env-file", str(args.env_file)]

    def run(self, command):
        return subprocess.check_output(
            command, cwd=ROOT, env=self.env, stderr=subprocess.PIPE, text=True
        ).strip()

    def compose(self, *command):
        print(f"Compose step: {command[0]}", flush=True)
        return self.run([*self.base, *command])

    def revision(self):
        result = self.compose(
            "exec",
            "-T",
            "db",
            "sh",
            "-ec",
            'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 '
            '-c "SELECT version_num FROM alembic_version"',
        )
        if not release_manifest.REVISION.fullmatch(result):
            raise ValueError("Existing database must have one migration revision")
        return result

    def current_images(self):
        images = {}
        for service in [*WRITERS, "proxy"]:
            identifier = self.compose("ps", "-q", service)
            if not identifier or "\n" in identifier:
                raise ValueError("Update requires one running instance of each app service")
            info = json.loads(self.run(["docker", "inspect", identifier]))[0]
            images[service] = info["Image"]
        if any(images[item] != images["api"] for item in WRITERS):
            raise ValueError("API and workers must use the same existing image")
        return [images["api"], images["proxy"]]

    def check_empty_project(self):
        if self.compose("ps", "-a", "-q"):
            raise ValueError("Init refused: project containers already exist")
        volumes = self.run(["docker", "volume", "ls", "--format", "{{.Name}}"])
        if f"{self.args.project}_postgres_data" in volumes.splitlines():
            raise ValueError("Init refused: persistent database volume already exists")
        for journal in self.args.state.parent.glob("*.json"):
            if journal.name.endswith(".dump.json"):
                continue
            value = json.loads(journal.read_text())
            if not isinstance(value, dict):
                raise ValueError("Init refused: invalid deployment journal")
            if value.get("format") == 1 and value.get("project") == self.args.project:
                raise ValueError("Init refused: deployment history already exists")

    def check_rollback_target(self, state):
        if (
            state.get("configuration_hash") != self.fingerprint
            or state.get("daemon") != self.daemon
        ):
            raise ValueError("Deployment configuration or Docker host changed")
        new = state.get("new_images")
        if not isinstance(new, list) or len(new) != 2:
            raise ValueError("Invalid target images in journal")
        for service in [*WRITERS, "proxy"]:
            identifier = self.compose("ps", "-a", "-q", service)
            if not identifier or "\n" in identifier:
                raise ValueError("Rollback requires the existing service containers")
            info = json.loads(self.run(["docker", "inspect", identifier]))[0]
            index = int(service == "proxy")
            if info["Image"] not in (state["old_images"][index], new[index]):
                raise ValueError("Obsolete journal: another release is installed")

    def preflight(self, manifest=None):
        self.compose("config", "--quiet")
        configuration = json.loads(self.compose("config", "--format", "json"))
        # Configuration can contain secrets: never print it or include it in the journal.
        self.fingerprint = configuration_hash(configuration)
        self.daemon = self.run(["docker", "info", "--format", "{{.ID}}"])
        environment = configuration["services"]["api"]["environment"]
        if environment.get("APP_ENV") != "production":
            raise ValueError("Release operations require the hardened deployment stack")
        origins = json.loads(environment["CORS_ORIGINS"])
        if len(origins) != 1:
            raise ValueError("Release expects one same-origin frontend/API site")
        self.origin = origins[0]
        self.image_ids = []
        for image in (self.env["APP_IMAGE"], self.env["WEB_IMAGE"]):
            if not image.startswith("sha256:"):
                self.run(["docker", "pull", image])
            metadata = json.loads(self.run(["docker", "image", "inspect", image]))[0]
            self.image_ids.append(metadata["Id"])
            if (
                manifest
                and (metadata["Config"].get("Labels") or {}).get(
                    "org.opencontainers.image.revision"
                )
                != manifest["commit"]
            ):
                raise ValueError("Image revision label does not match the release")
        if (
            manifest
            and release_manifest.schema_head(self.env["APP_IMAGE"]) != manifest["schema_revision"]
        ):
            raise ValueError("Manifest schema does not match the API image")

    def stop(self):
        self.compose("stop", "proxy")
        self.compose("stop", *WRITERS)

    def start(self):
        self.compose(
            "up",
            "-d",
            "--no-build",
            "--pull",
            "never",
            "--no-deps",
            "--wait",
            "--wait-timeout",
            "180",
            *WRITERS,
        )
        self.compose("up", "-d", "--no-build", "--pull", "never", "--no-deps", "--wait", "proxy")
        wait_for_https(self.origin, self.args.ca_file)

    def backup(self, revision):
        archive = self.args.state.with_suffix(".dump")
        common = [
            str(archive),
            "--compose-file",
            str(ROOT / "compose.production.yaml"),
        ]
        for override in compose_overrides(self.args):
            common += ["--compose-file", str(override)]
        common += ["--env-file", str(self.args.env_file), "--project-name", self.args.project]
        script = str(ROOT / "scripts/database_backup.py")
        print("Creating database backup", flush=True)
        self.run([sys.executable, script, "backup", *common])
        print("Verifying database restore", flush=True)
        self.run(
            [sys.executable, script, "restore-check", *common, "--expected-revision", revision]
        )
        return str(archive)

    def active_images(self):
        path = self.args.state.parent / "active.env"
        temporary = path.with_suffix(".env.tmp")
        with temporary.open("x", encoding="utf-8") as stream:
            stream.write(f"APP_IMAGE={self.env['APP_IMAGE']}\nWEB_IMAGE={self.env['WEB_IMAGE']}\n")
        temporary.replace(path)


def apply(args, manifest):
    deployment = Deployment(args, [manifest["api_image"], manifest["web_image"]])
    deployment.preflight(manifest)
    old = deployment.current_images()
    state = {
        "format": 1,
        "project": args.project,
        "before_revision": deployment.revision(),
        "old_images": old,
        "new_images": deployment.image_ids,
        "configuration_hash": deployment.fingerprint,
        "daemon": deployment.daemon,
        "target": manifest,
        "phase": "prepared",
    }
    args.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with args.state.open("x", encoding="utf-8") as stream:
        json.dump(state, stream, indent=2)
    stopped = False
    try:
        print("Stopping ingress and writers for backup/migration", flush=True)
        stopped = True
        deployment.stop()
        state["phase"] = "backup"
        save(args.state, state)
        state["backup"] = deployment.backup(state["before_revision"])
        state["phase"] = "migration"
        save(args.state, state)
        deployment.compose(
            "run",
            "--rm",
            "--no-deps",
            "--pull",
            "never",
            "migrate",
            "alembic",
            "upgrade",
            manifest["schema_revision"],
        )
        if deployment.revision() != manifest["schema_revision"]:
            raise ValueError("Database did not reach the release schema")
        state["phase"] = "starting"
        save(args.state, state)
        deployment.start()
        deployment.active_images()
        state["phase"] = "complete"
        save(args.state, state)
        print("Release applied; HTTPS readiness and frontend passed")
    except Exception:
        if stopped:
            deployment.stop()
        # Preserve phase/backup/old images for operator recovery. Do not downgrade the database.
        raise


def initialize(args, manifest):
    deployment = Deployment(args, [manifest["api_image"], manifest["web_image"]])
    deployment.preflight(manifest)
    deployment.check_empty_project()
    check_available_memory(
        getattr(args, "min_available_mib", 0), getattr(args, "memory_wait_seconds", 0)
    )
    state = {
        "format": 1,
        "project": args.project,
        "operation": "init",
        "new_images": deployment.image_ids,
        "configuration_hash": deployment.fingerprint,
        "daemon": deployment.daemon,
        "target": manifest,
        "phase": "prepared",
    }
    args.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with args.state.open("x", encoding="utf-8") as stream:
        json.dump(state, stream, indent=2)
    started = False
    try:
        # There is no existing application database to back up on a first installation.
        deployment.compose("pull", "db", "redis")
        started = True
        deployment.compose("up", "-d", "--no-build", "--wait", "db", "redis")
        state["phase"] = "migration"
        save(args.state, state)
        deployment.compose(
            "run",
            "--rm",
            "--no-deps",
            "--pull",
            "never",
            "migrate",
            "alembic",
            "upgrade",
            manifest["schema_revision"],
        )
        if deployment.revision() != manifest["schema_revision"]:
            raise ValueError("Database did not reach the release schema")
        state["phase"] = "starting"
        save(args.state, state)
        deployment.start()
        deployment.active_images()
        state["phase"] = "complete"
        save(args.state, state)
        print("First installation complete; HTTPS readiness and frontend passed")
    except Exception:
        if started:
            deployment.stop()
        # Preserve all volumes and journal evidence; a partial init needs operator recovery.
        raise


def rollback(args, state):
    if state.get("project") != args.project or state.get("format") != 1:
        raise ValueError("Journal does not belong to this project")
    old = state.get("old_images")
    if (
        not isinstance(old, list)
        or len(old) != 2
        or any(not isinstance(x, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", x) for x in old)
    ):
        raise ValueError("Invalid rollback images")
    deployment = Deployment(args, old)
    deployment.preflight()
    deployment.check_rollback_target(state)
    rollback_allowed(state, deployment.revision())
    try:
        deployment.stop()
        deployment.start()
        deployment.active_images()
        state["phase"] = "rolled_back"
        save(args.state, state)
        print("Previous code restored; database unchanged; HTTPS smoke passed")
    except Exception:
        deployment.stop()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["init", "apply", "rollback"])
    parser.add_argument("--project", required=True)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument(
        "--compose-override",
        type=Path,
        action="append",
        help="Additional Compose file; repeat in order for ingress and pilot overlays",
    )
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--ca-file", type=Path, help="Trusted private CA for an isolated drill")
    parser.add_argument(
        "--min-available-mib",
        type=int,
        default=0,
        help="First-installation memory check after image preparation",
    )
    parser.add_argument(
        "--memory-wait-seconds",
        type=int,
        default=0,
        help="Wait at most this many seconds for first-installation memory (0-300)",
    )
    parser.add_argument(
        "--execute", action="store_true", help="Without this flag only print the plan"
    )
    args = parser.parse_args()
    try:
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", args.project):
            raise ValueError("Invalid Compose project name")
        args.env_file = args.env_file.resolve(strict=True)
        args.compose_override = [path.resolve(strict=True) for path in compose_overrides(args)]
        if args.min_available_mib < 0:
            raise ValueError("Invalid memory threshold")
        if not 0 <= args.memory_wait_seconds <= 300:
            raise ValueError("Invalid memory wait timeout")
        args.state = args.state.resolve()
        release_action = args.action in {"init", "apply"}
        if release_action and args.manifest is None:
            raise ValueError("Apply requires --manifest")
        value = json.loads((args.manifest if release_action else args.state).read_text())
        if release_action:
            release_manifest.validate(value)
        if not args.execute:
            print(f"Plan for {args.project}: {args.action}; no commands executed.")
            print(
                "init: refuse existing containers/data -> verify images -> create DB/Redis -> "
                "migrate -> start -> HTTPS smoke -> active.env"
            )
            print(
                "apply: verify images -> stop ingress/writers -> backup+restore drill -> "
                "migrate -> start -> HTTPS smoke -> active.env"
            )
            print(
                "rollback: require unchanged schema -> previous local images -> HTTPS smoke; "
                "never restore/downgrade the database"
            )
            return 0
        with lock(args.env_file.parent / f".{args.project}.release.lock"):
            {"init": initialize, "apply": apply, "rollback": rollback}[args.action](args, value)
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        if type(error) is ValueError:
            print(str(error), file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            # Commands contain identifiers/paths only; never expose captured service output.
            print(f"Failed command (exit {error.returncode}): {error.cmd}", file=sys.stderr)
        print(
            f"Release operation failed ({type(error).__name__}). Inspect the journal if present; "
            "a partial deployment may leave application services stopped. "
            "No automatic database rollback.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
