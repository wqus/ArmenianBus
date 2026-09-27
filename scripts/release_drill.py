"""Exercise a same-schema release and rollback inside the smoke runner's temporary stack."""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from release_manifest import schema_head


def drill(run, compose, project, root):
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
