"""Exercise the deploy hook with real TLS pairs and an isolated fake Nginx."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASH = (
    str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe")
    if os.name == "nt"
    else shutil.which("bash")
)


def shell_path(path: Path) -> str:
    value = path.resolve().as_posix()
    return f"/{value[0].lower()}{value[2:]}" if os.name == "nt" else value


@unittest.skipUnless(BASH and Path(BASH).exists(), "Bash is required")
class CertbotNginxHookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.live = self.base / "live"
        self.source = self.live / "bus.mathbot.site"
        self.source.mkdir(parents=True)
        self.dest = self.base / "certs"
        self.dest.mkdir()
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.events = self.base / "events"
        self.events.touch()
        self.cert = self.dest / "bus_fullchain.pem"
        self.key = self.dest / "bus_privkey.pem"
        for name in ("old", "new"):
            self.run_bash(
                "MSYS2_ARG_CONV_EXCL=/CN= openssl req -x509 -newkey rsa:2048 -nodes -days 1 "
                f"-subj /CN={name}.example "
                f"-keyout '{shell_path(self.base / (name + '.key'))}' "
                f"-out '{shell_path(self.base / (name + '.pem'))}'"
            )
        self.old_cert = (self.base / "old.pem").read_bytes()
        self.old_key = (self.base / "old.key").read_bytes()
        self.new_cert = (self.base / "new.pem").read_bytes()
        self.new_key = (self.base / "new.key").read_bytes()
        self.cert.write_bytes(self.old_cert)
        self.key.write_bytes(self.old_key)
        (self.source / "fullchain.pem").write_bytes(self.new_cert)
        (self.source / "privkey.pem").write_bytes(self.new_key)
        # Git Bash has no flock; locking itself is exercised on the VPS.
        (self.bin / "flock").write_text("#!/bin/bash\nexit 0\n", encoding="utf-8")
        (self.bin / "docker").write_text(
            """#!/bin/bash
if [[ "$4" == '-t' ]]; then
    echo test >> "$HOOK_EVENTS"
    count=$(grep -c '^test$' "$HOOK_EVENTS")
    if [[ "$FAIL_MODE" == validate && "$count" == 2 ]]; then exit 1; fi
else
    echo reload >> "$HOOK_EVENTS"
    if [[ "$FAIL_MODE" == reload ]]; then exit 1; fi
fi
""",
            encoding="utf-8",
        )
        for file in self.bin.iterdir():
            file.chmod(0o755)
        script = (ROOT / "deploy/certbot-nginx-deploy.sh").read_text(encoding="utf-8")
        # Rewrite only the test copy: production paths remain fixed in the source.
        script = script.replace("/etc/letsencrypt/live", shell_path(self.live))
        script = script.replace("/opt/nginx-proxy/certs", shell_path(self.dest))
        script = script.replace(
            "/run/lock/certbot-nginx-deploy.lock", shell_path(self.base / "lock")
        )
        script = script.replace("EUID != 0", "0 != 0")
        script = script.replace(" -o root -g root", "")
        self.hook = self.base / "hook.sh"
        self.hook.write_text(script, encoding="utf-8", newline="\n")
        bash_path = self.run_bash('printf "%s" "$PATH"').stdout.strip()
        self.env = dict(os.environ)
        self.env.update(
            PATH=f"{shell_path(self.bin)}:{bash_path}",
            RENEWED_LINEAGE=shell_path(self.source),
            HOOK_EVENTS=shell_path(self.events),
            FAIL_MODE="",
        )

    def run_bash(self, command):
        return subprocess.run([BASH, "-c", command], capture_output=True, text=True, check=True)

    def execute(self):
        return subprocess.run(
            [BASH, shell_path(self.hook)], env=self.env, capture_output=True, text=True
        )

    def assert_old_pair(self):
        self.assertEqual(self.cert.read_bytes(), self.old_cert)
        self.assertEqual(self.key.read_bytes(), self.old_key)

    def test_success_publishes_pair_and_reloads(self):
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.cert.read_bytes(), self.new_cert)
        self.assertEqual(self.key.read_bytes(), self.new_key)
        self.assertEqual(self.events.read_text().splitlines(), ["test", "test", "reload"])
        self.assertEqual(Path(str(self.key) + ".previous").read_bytes(), self.old_key)

    def test_invalid_pair_never_publishes_or_reloads(self):
        (self.source / "privkey.pem").write_bytes(self.old_key)
        result = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assert_old_pair()
        self.assertEqual(self.events.read_text(), "")

    def test_validation_failure_restores_pair_without_reload(self):
        self.env["FAIL_MODE"] = "validate"
        self.assertNotEqual(self.execute().returncode, 0)
        self.assert_old_pair()
        self.assertEqual(self.events.read_text().splitlines(), ["test", "test"])

    def test_reload_command_failure_restores_files(self):
        self.env["FAIL_MODE"] = "reload"
        self.assertNotEqual(self.execute().returncode, 0)
        self.assert_old_pair()

    def test_unknown_lineage_is_ignored(self):
        self.env["RENEWED_LINEAGE"] = shell_path(self.live / "unrelated.example")
        self.assertEqual(self.execute().returncode, 0)
        self.assert_old_pair()
        self.assertEqual(self.events.read_text(), "")
