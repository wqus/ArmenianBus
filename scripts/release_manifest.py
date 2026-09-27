"""Record a tested, published API/web pair without credentials or mutable deployment tags."""

import argparse
import json
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path

PINNED = re.compile(r"(?:[a-z0-9][a-z0-9./:_-]*@)?sha256:[0-9a-f]{64}")
REVISION = re.compile(r"[a-zA-Z0-9_]{1,64}")


def validate(value):
    if not isinstance(value, dict) or value.get("format") != 1:
        raise ValueError("Unsupported release manifest")
    for name in ("api_image", "web_image"):
        if not isinstance(value.get(name), str) or not PINNED.fullmatch(value[name]):
            raise ValueError("Release images must be pinned digests or imported local image IDs")
    if not re.fullmatch(r"[0-9a-f]{40}", value.get("commit", "")):
        raise ValueError("Release requires a full Git commit SHA")
    if not REVISION.fullmatch(value.get("schema_revision", "")):
        raise ValueError("Invalid schema revision")
    return value


def inspect(image):
    return json.loads(subprocess.check_output(["docker", "image", "inspect", image]))[0]


def schema_head(image):
    output = subprocess.check_output(
        ["docker", "run", "--rm", image, "alembic", "heads"], text=True
    ).strip()
    match = re.fullmatch(r"([a-zA-Z0-9_]{1,64}) \(head\)", output)
    if not match:
        raise ValueError("Release must have exactly one Alembic head")
    return match[1]


def published_digest(image, metadata):
    repository = image.rsplit(":", 1)[0]
    matches = [x for x in metadata.get("RepoDigests", []) if x.startswith(repository + "@")]
    if len(matches) != 1:
        raise ValueError("Image must have exactly one published digest for its repository")
    return matches[0]


def create(api, web, commit):
    images = [inspect(api), inspect(web)]
    for metadata in images:
        if (metadata["Config"].get("Labels") or {}).get(
            "org.opencontainers.image.revision"
        ) != commit:
            raise ValueError("API/web revision label does not match the release commit")
    return validate(
        {
            "format": 1,
            "commit": commit,
            "created_at": datetime.now(UTC).isoformat(),
            "api_image": published_digest(api, images[0]),
            "web_image": published_digest(web, images[1]),
            "schema_revision": schema_head(api),
        }
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-image", required=True)
    parser.add_argument("--web-image", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manifest = create(args.api_image, args.web_image, args.commit)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(manifest, stream, indent=2)


if __name__ == "__main__":
    main()
