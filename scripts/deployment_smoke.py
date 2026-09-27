"""Build and verify an isolated HTTPS stack; never operates on an existing Compose project."""

import argparse
import os
import secrets
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true", help="Reuse deployment-smoke images")
    args = parser.parse_args()
    project = f"armeniabus-deployment-smoke-{secrets.token_hex(4)}"
    env = {
        **os.environ,
        "COMPOSE_PROFILES": "",
        "RUN_DEPLOYMENT_SMOKE": "1",
        "APP_IMAGE": "armeniabus-api:deployment-smoke",
        "WEB_IMAGE": "armeniabus-web:deployment-smoke",
        "APP_DOMAIN": "armeniabus.localhost",
        "POSTGRES_DB": "armeniabus_deployment_test",
        "POSTGRES_USER": "armeniabus",
        "POSTGRES_PASSWORD": secrets.token_hex(32),
        "POSTGRES_APP_PASSWORD": secrets.token_hex(32),
        "JWT_SECRET_KEY": secrets.token_hex(48),
        "PAYMENTS_ENABLED": "false",
        "NOTIFICATIONS_ENABLED": "false",
        "YOOKASSA_TEST_MODE": "true",
        "TLS_ISSUER": "internal",
        "PROXY_BIND": "127.0.0.1",
        "HTTP_PORT": "18080",
        "HTTPS_PORT": "18443",
        "ORIGIN_PORT_SUFFIX": ":18443",
        "EDGE_SUBNET": "172.30.90.0/24",
        "EDGE_DYNAMIC_RANGE": "172.30.90.128/25",
        "PROXY_IP": "172.30.90.2",
    }
    compose = [
        "docker",
        "compose",
        "-p",
        project,
        "-f",
        "compose.production.yaml",
        "--env-file",
        ".env.production.example",
    ]

    def run(command, **kwargs):
        return subprocess.run(command, cwd=ROOT, env=env, check=True, **kwargs)

    print(f"Isolated project: {project}", flush=True)
    try:
        run([*compose, "config", "--quiet"])
        if not args.skip_build:
            run([*compose, "build", "api", "proxy"])
        run(
            [
                *compose,
                "run",
                "--rm",
                "--no-deps",
                "proxy",
                "caddy",
                "validate",
                "--config",
                "/etc/caddy/Caddyfile",
            ]
        )
        run([*compose, "up", "-d", "--wait", "db", "redis"])
        run([*compose, "run", "--rm", "migrate"])
        run(
            [
                *compose,
                "up",
                "-d",
                "--wait",
                "--wait-timeout",
                "120",
                "api",
                "worker",
                "payment-worker",
                "notification-worker",
                "proxy",
            ]
        )
        npm = shutil.which("npm")
        if not npm:
            raise RuntimeError("Node.js 24 / npm is required for the browser smoke")
        run([npm, "--prefix", "frontend", "run", "test:deployment"])
    finally:
        # Only the unique project allocated above, including its synthetic DB and local CA.
        run([*compose, "down", "--volumes", "--remove-orphans"])


if __name__ == "__main__":
    main()
