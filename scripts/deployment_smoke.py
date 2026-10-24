"""Build and verify an isolated HTTPS stack; never operates on an existing Compose project."""

import argparse
import ipaddress
import json
import os
import secrets
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def select_smoke_subnets(occupied):
    """Select two explicit /24s so Docker cannot allocate a supernet around the edge."""
    used = [ipaddress.ip_network(value) for value in occupied]
    selected = []
    for pool in ("172.16.0.0/12", "10.192.0.0/16"):
        for candidate in ipaddress.ip_network(pool).subnets(new_prefix=24):
            if any(candidate.overlaps(network) for network in used if network.version == 4):
                continue
            selected.append(candidate)
            used.append(candidate)
            if len(selected) == 2:
                return tuple(selected)
    raise RuntimeError("No non-overlapping private subnets available for deployment smoke")


def occupied_docker_subnets():
    ids = subprocess.check_output(["docker", "network", "ls", "-q"], text=True).split()
    if not ids:
        return []
    networks = json.loads(
        subprocess.check_output(["docker", "network", "inspect", *ids], text=True)
    )
    return [
        entry["Subnet"]
        for network in networks
        for entry in network.get("IPAM", {}).get("Config", []) or []
        if entry.get("Subnet")
    ]


def prepare_smoke_networks():
    backend, edge = select_smoke_subnets(occupied_docker_subnets())
    with tempfile.NamedTemporaryFile(
        mode="w", prefix="armeniabus-smoke-", suffix=".json", delete=False
    ) as override:
        json.dump(
            {"networks": {"backend": {"ipam": {"config": [{"subnet": str(backend)}]}}}},
            override,
        )
    return (
        {
            "EDGE_SUBNET": str(edge),
            "EDGE_DYNAMIC_RANGE": str(list(edge.subnets(new_prefix=25))[1]),
            "PROXY_IP": str(edge.network_address + 2),
        },
        Path(override.name),
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true", help="Reuse deployment-smoke images")
    parser.add_argument("--api-image", default="armeniabus-api:deployment-smoke")
    parser.add_argument("--web-image", default="armeniabus-web:deployment-smoke")
    parser.add_argument("--release-drill", action="store_true")
    args = parser.parse_args()
    project = f"armeniabus-deployment-smoke-{secrets.token_hex(4)}"
    network_env, override_path = prepare_smoke_networks()
    env = {
        **os.environ,
        "COMPOSE_PROFILES": "",
        "RUN_DEPLOYMENT_SMOKE": "1",
        "APP_IMAGE": args.api_image,
        "WEB_IMAGE": args.web_image,
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
        **network_env,
    }
    # A temporary override pins the backend too; automatic IPAM could otherwise
    # reserve a /16 containing the already selected /24 for the edge network.
    compose = [
        "docker",
        "compose",
        "-p",
        project,
        "-f",
        "compose.production.yaml",
        "-f",
        str(override_path),
        "--env-file",
        ".env.production.example",
    ]

    def run(command, **kwargs):
        return subprocess.run(command, cwd=ROOT, env=env, check=True, **kwargs)

    print(f"Isolated project: {project}; edge {network_env['EDGE_SUBNET']}", flush=True)
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
        if args.release_drill:
            from release_drill import drill

            drill(run, compose, project, ROOT, overrides=[override_path])
    finally:
        # Only the unique project allocated above, including its synthetic DB and local CA.
        try:
            run([*compose, "down", "--volumes", "--remove-orphans"])
        finally:
            override_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
