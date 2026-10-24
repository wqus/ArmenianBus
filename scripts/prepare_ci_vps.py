"""One-time root setup for the bounded armatrans pilot; never prints application secrets."""

import argparse
import ipaddress
import json
import os
import secrets
import subprocess
import sys
from pathlib import Path

ACCOUNT = "armeniabus-ci"
BASE = Path("/opt/armeniabus")
SUBNET = ipaddress.ip_network("172.30.10.0/24")


def output(command):
    return subprocess.check_output(command, stderr=subprocess.PIPE, text=True).strip()


def check_subnets(networks, routes):
    subnets = [
        item["Subnet"]
        for network in networks
        for item in network.get("IPAM", {}).get("Config", []) or []
        if item.get("Subnet")
    ]
    subnets += [route["dst"] for route in routes if route.get("dst") not in {None, "default"}]
    for value in subnets:
        network = ipaddress.ip_network(value, strict=False)
        if network.version == 4 and network.prefixlen and SUBNET.overlaps(network):
            raise ValueError("The pilot subnet overlaps an existing Docker network or route")


def prepare(public_key):
    if os.name != "posix" or os.geteuid() != 0:
        raise ValueError("Run this setup with sudo on the Ubuntu VPS")
    import pwd

    key = public_key.read_text().strip()
    if not key.startswith("ssh-ed25519 ") or "\n" in key:
        raise ValueError("Provide a single Ed25519 public key, not a private key")
    output(["ssh-keygen", "-l", "-f", str(public_key)])
    identifiers = output(["docker", "network", "ls", "-q"]).splitlines()
    networks = json.loads(output(["docker", "network", "inspect", *identifiers]))
    routes = json.loads(output(["ip", "-j", "-4", "route", "show", "table", "all"]))
    check_subnets(networks, routes)
    ingress = json.loads(
        output(
            [
                "docker",
                "inspect",
                "nginx-proxy-nginx-1",
                "--format",
                "{{json .NetworkSettings.Networks}}",
            ]
        )
    )
    proxy_ip = ingress["nginx-proxy"]["IPAddress"]
    ipaddress.ip_address(proxy_ip)
    try:
        account = pwd.getpwnam(ACCOUNT)
    except KeyError:
        subprocess.run(["useradd", "--create-home", "--shell", "/bin/bash", ACCOUNT], check=True)
        account = pwd.getpwnam(ACCOUNT)
    if account.pw_uid == 0:
        raise ValueError("Deployment account must not have UID 0")
    subprocess.run(["usermod", "-aG", "docker", ACCOUNT], check=True)

    def directory(path):
        if path.is_symlink():
            raise ValueError("Setup refuses symlinked deployment directories")
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chown(path, account.pw_uid, account.pw_gid)
        path.chmod(0o700)

    for suffix in (
        "",
        "current",
        "incoming",
        "shared",
        "release-state",
        "release-state/production",
    ):
        directory(BASE / suffix)
    ssh_directory = Path(account.pw_dir) / ".ssh"
    directory(ssh_directory)
    authorized = ssh_directory / "authorized_keys"
    if authorized.is_symlink():
        raise ValueError("Setup refuses a symlinked authorized_keys")
    existing = authorized.read_text() if authorized.exists() else ""
    if key.split()[1] not in existing:
        with authorized.open("a", encoding="utf-8") as stream:
            if existing and not existing.endswith("\n"):
                stream.write("\n")
            # Disable forwarding and PTY; SCP/SFTP and noninteractive deployment commands remain.
            stream.write("restrict " + key + "\n")
    os.chown(authorized, account.pw_uid, account.pw_gid)
    authorized.chmod(0o600)

    env_file = BASE / "shared/production.env"
    if env_file.is_symlink():
        raise ValueError("Setup refuses a symlinked env-file")
    if not env_file.exists():
        values = {
            "APP_DOMAIN": "bus.mathbot.site",
            "POSTGRES_DB": "armeniabus",
            "POSTGRES_USER": "armeniabus",
            "POSTGRES_PASSWORD": secrets.token_hex(32),
            "POSTGRES_APP_PASSWORD": secrets.token_hex(32),
            "JWT_SECRET_KEY": secrets.token_hex(48),
            "PAYMENTS_ENABLED": "false",
            "YOOKASSA_TEST_MODE": "true",
            "NOTIFICATIONS_ENABLED": "false",
            "WORKER_STALE_SECONDS": "600",
            "EDGE_SUBNET": str(SUBNET),
            "EDGE_DYNAMIC_RANGE": "172.30.10.128/25",
            "PROXY_IP": "172.30.10.2",
            "INGRESS_NETWORK": "nginx-proxy",
            "INGRESS_PROXY_IP": proxy_ip,
        }
        descriptor = os.open(env_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            for name, value in values.items():
                stream.write(f"{name}={value}\n")
        os.chown(env_file, account.pw_uid, account.pw_gid)
        print("Created protected application env-file; secret values were not printed")
    else:
        if env_file.stat().st_uid != account.pw_uid or env_file.stat().st_mode & 0o077:
            raise ValueError("Existing env-file needs deployment-account ownership and mode 600")
        print("Existing application env-file preserved")
    profile = BASE / "shared/deployment-profile"
    if not profile.exists():
        with profile.open("x", encoding="utf-8") as stream:
            stream.write("pilot\n")
        os.chown(profile, account.pw_uid, account.pw_gid)
        profile.chmod(0o600)
    elif profile.is_symlink() or profile.read_text().strip() != "pilot":
        raise ValueError("Existing profile differs from pilot; review it manually")
    print(f"Prepared account {ACCOUNT}, deployment directory {BASE}, ingress IP {proxy_ip}")
    print("No application containers were created. Check SSH AllowUsers rules before connecting.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-key", required=True, type=Path)
    args = parser.parse_args()
    try:
        prepare(args.public_key.resolve(strict=True))
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        if type(error) is ValueError:
            print(str(error), file=sys.stderr)
        print(
            f"VPS setup failed ({type(error).__name__}); review the completed steps",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
