"""Versioned schematic layouts, not manufacturer-certified configurations."""

import json
from importlib.resources import files

CATALOG = json.loads(files(__package__).joinpath("layouts.json").read_text(encoding="utf-8"))
LAYOUTS = {layout["id"]: layout for layout in CATALOG["layouts"]}
MODELS = {model["id"]: model for model in CATALOG["models"]}
