"""Exercise a same-schema release and rollback inside the smoke runner's temporary stack."""

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from deployment_smoke import prepare_smoke_networks
from release_manifest import schema_head


def drill(run, compose, project, root, overrides=()):
    def output(command):
        return run(command, capture_output=True, text=True).stdout.strip()

    original = []
    for service in ("api", "proxy"):
        container = output([*compose, "ps", "-q", service])
        original.append(json.loads(output(["docker", "inspect", container]))[0]["Image"])
    commit = output(["git", "rev-parse", "HEAD"])
    derived = []
    try:
        for index, base in enumerate(original):
            result = output_build(run, base, commit, f"{project}:base-{index}")
            derived.append(result)
        with tempfile.TemporaryDirectory(prefix="armeniabus-release-drill-") as directory:
            temporary = Path(directory)
            ca = temporary / "ca.crt"
            ca.write_text(
                output(
                    [
                        *compose,
                        "exec",
                        "-T",
                        "proxy",
                        "cat",
                        "/data/caddy/pki/authorities/local/root.crt",
                    ]
                ),
                encoding="utf-8",
            )
            manifest = temporary / "release.json"
            manifest.write_text(
                json.dumps(
                    {
                        "format": 1,
                        "commit": commit,
                        "api_image": derived[0],
                        "web_image": derived[1],
                        "schema_revision": schema_head(derived[0]),
                    }
                ),
                encoding="utf-8",
            )
            common = [
                "--project",
                project,
                "--env-file",
                str(root / ".env.production.example"),
                "--state",
                str(temporary / "journal.json"),
                "--ca-file",
                str(ca),
                "--execute",
            ]
            for override in overrides:
                common.extend(["--compose-override", str(override)])
            script = [sys.executable, str(root / "scripts/release_deploy.py")]
            run([*script, "apply", *common, "--manifest", str(manifest)])
            for service, expected in zip(("api", "proxy"), derived, strict=True):
                container = output([*compose, "ps", "-q", service])
                assert json.loads(output(["docker", "inspect", container]))[0]["Image"] == expected
            run([*script, "rollback", *common])
            for service, expected in zip(("api", "proxy"), original, strict=True):
                container = output([*compose, "ps", "-q", service])
                assert json.loads(output(["docker", "inspect", container]))[0]["Image"] == expected
            state = json.loads((temporary / "journal.json").read_text())
            assert state["phase"] == "rolled_back"
            assert Path(state["backup"]).stat().st_size > 0
            print("Release drill passed: verified backup, image replacement, HTTPS, code rollback")
            run([*compose, "stop", "proxy"])
            bootstrap_drill(derived, commit, root)
    finally:
        # Only untagged images built by this drill; never force removal of an in-use image.
        for image in derived:
            try:
                run(["docker", "image", "rm", image], capture_output=True)
            except subprocess.CalledProcessError:
                pass


def output_build(run, base, commit, tag):
    # BuildKit resolves FROM by name; bare local image IDs may be treated as registry names.
    run(["docker", "image", "tag", base, tag])
    dockerfile = (
        f"FROM {tag}\nLABEL org.opencontainers.image.revision={commit}\n"
        f"LABEL org.armeniabus.release-drill={tag}\n"
    )
    try:
        result = run(
            ["docker", "build", "--quiet", "-"], input=dockerfile, capture_output=True, text=True
        )
    finally:
        run(["docker", "image", "rm", tag], capture_output=True)
    image = result.stdout.strip()
    if not image.startswith("sha256:"):
        raise ValueError("Drill build did not return an image ID")
    return image


def bootstrap_drill(images, commit, root):
    """Prove the real first-installation path under the bounded pilot profile."""
    project = f"armeniabus-init-drill-{secrets.token_hex(4)}"
    network_env, network_override = prepare_smoke_networks()
    environment = {
        **os.environ,
        "APP_IMAGE": images[0],
        "WEB_IMAGE": images[1],
        "APP_DOMAIN": "armeniabus.localhost",
        "POSTGRES_DB": "armeniabus_init_drill",
        "POSTGRES_USER": "armeniabus",
        "POSTGRES_PASSWORD": secrets.token_hex(32),
        "POSTGRES_APP_PASSWORD": secrets.token_hex(32),
        "JWT_SECRET_KEY": secrets.token_hex(48),
        "PAYMENTS_ENABLED": "false",
        "NOTIFICATIONS_ENABLED": "false",
        "YOOKASSA_TEST_MODE": "true",
        "TLS_ISSUER": "internal",
        "COMPOSE_PROFILES": "",
        "RUN_DEPLOYMENT_SMOKE": "1",
        "PROXY_BIND": "127.0.0.1",
        "HTTP_PORT": "18080",
        "HTTPS_PORT": "18443",
        "ORIGIN_PORT_SUFFIX": ":18443",
        **network_env,
    }
    compose = [
        "docker",
        "compose",
        "-p",
        project,
        "-f",
        "compose.production.yaml",
        "-f",
        "compose.pilot.yaml",
        "-f",
        str(network_override),
        "--env-file",
        ".env.production.example",
    ]

    def run(command, **kwargs):
        return subprocess.run(command, cwd=root, env=environment, check=True, **kwargs)

    def output(command):
        return run(command, capture_output=True, text=True).stdout.strip()

    seed = project + "-ca-seed"
    seed_created = False
    try:
        with tempfile.TemporaryDirectory(prefix="armeniabus-bootstrap-drill-") as directory:
            temporary = Path(directory)
            # Seed only the disposable Caddy CA volume so HTTPS can be verified on first boot.
            for volume in ("caddy_data", "caddy_config"):
                run(
                    [
                        "docker",
                        "volume",
                        "create",
                        "--label",
                        f"com.docker.compose.project={project}",
                        "--label",
                        f"com.docker.compose.volume={volume}",
                        f"{project}_{volume}",
                    ],
                    capture_output=True,
                )
            run(
                [
                    "docker",
                    "run",
                    "-d",
                    "--name",
                    seed,
                    "--label",
                    f"com.docker.compose.project={project}",
                    "--network",
                    "none",
                    "--memory",
                    "64m",
                    "--cpus",
                    "0.10",
                    "-e",
                    "APP_DOMAIN=armeniabus.localhost",
                    "-e",
                    "TLS_ISSUER=internal",
                    "-v",
                    f"{project}_caddy_data:/data",
                    "-v",
                    f"{project}_caddy_config:/config",
                    images[1],
                ]
            )
            seed_created = True
            for _ in range(80):
                try:
                    certificate = output(
                        [
                            "docker",
                            "exec",
                            seed,
                            "cat",
                            "/data/caddy/pki/authorities/local/root.crt",
                        ]
                    )
                    break
                except subprocess.CalledProcessError:
                    time.sleep(0.25)
            else:
                raise ValueError("Disposable Caddy did not create its private CA")
            run(["docker", "rm", "-f", seed], capture_output=True)
            seed_created = False
            ca = temporary / "ca.crt"
            ca.write_text(certificate, encoding="utf-8")
            manifest = temporary / "release.json"
            manifest.write_text(
                json.dumps(
                    {
                        "format": 1,
                        "commit": commit,
                        "api_image": images[0],
                        "web_image": images[1],
                        "schema_revision": schema_head(images[0]),
                    }
                ),
                encoding="utf-8",
            )
            run(
                [
                    sys.executable,
                    str(root / "scripts/release_deploy.py"),
                    "init",
                    "--project",
                    project,
                    "--env-file",
                    str(root / ".env.production.example"),
                    "--compose-override",
                    str(root / "compose.pilot.yaml"),
                    "--compose-override",
                    str(network_override),
                    "--state",
                    str(temporary / "state/init.json"),
                    "--manifest",
                    str(manifest),
                    "--ca-file",
                    str(ca),
                    "--execute",
                ]
            )
            state = json.loads((temporary / "state/init.json").read_text())
            assert state["phase"] == "complete" and "backup" not in state
            npm = shutil.which("npm")
            if not npm:
                raise ValueError("npm is required for the bounded pilot browser smoke")
            run([npm, "--prefix", "frontend", "run", "test:deployment"])
            containers = output([*compose, "ps", "-q"]).splitlines()
            run(
                [
                    "docker",
                    "stats",
                    "--no-stream",
                    "--format",
                    "table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}",
                    *containers,
                ]
            )
            print("Bootstrap drill passed: pilot limits, first migration, HTTPS and workers")
    except Exception:
        # Inspect only state, never Config.Env (which contains generated credentials).
        containers = output([*compose, "ps", "-aq"]).splitlines()
        if containers:
            subprocess.run(
                ["docker", "inspect", "--format", "{{.Name}} {{json .State}}", *containers],
                cwd=root,
                env=environment,
                check=False,
            )
        raise
    finally:
        # Only this newly allocated synthetic project; no production volume is eligible.
        try:
            if seed_created:
                run(["docker", "rm", "-f", seed], capture_output=True)
        finally:
            try:
                run([*compose, "down", "--volumes", "--remove-orphans"])
            finally:
                network_override.unlink(missing_ok=True)
