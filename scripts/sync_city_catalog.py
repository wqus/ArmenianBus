"""Generate the browser's release-local copy from the canonical Python catalog."""

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src/armeniabus/modules/cities/catalog.json"
TARGET = ROOT / "frontend/src/features/cities/catalog.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        if not TARGET.exists() or json.loads(TARGET.read_text(encoding="utf-8")) != json.loads(
            SOURCE.read_text(encoding="utf-8")
        ):
            raise SystemExit("City catalog is stale: run python scripts/sync_city_catalog.py")
    else:
        TARGET.write_bytes(SOURCE.read_bytes())


if __name__ == "__main__":
    main()
