"""Release-versioned city identities shared with the browser catalog."""

import json
import unicodedata
from importlib.resources import files

CITIES = json.loads(files(__package__).joinpath("catalog.json").read_text(encoding="utf-8"))


def normalized(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().replace("ё", "е").split())


def aliases(city: dict) -> list[str]:
    return [city["id"], *city["names"].values(), *city["aliases"]]


def resolve(value: str, country: str | None = None) -> dict | None:
    key = normalized(value)
    matches = [city for city in CITIES if any(normalized(a) == key for a in aliases(city))]
    if country:
        if matches and not any(city["country"] == country for city in matches):
            raise ValueError("City does not belong to the selected country")
        matches = [city for city in matches if city["country"] == country]
    if len(matches) > 1:
        raise ValueError("City name is ambiguous; select a city with its country")
    return matches[0] if matches else None


def canonical_name(value: str, country: str) -> str:
    city = resolve(value, country)
    # Preserve legacy/custom route names; known cities always get one spelling.
    return city["names"]["ru"] if city else value.strip()


def departure_zone(origin: str, country: str, supplied: str | None = None) -> str:
    city = resolve(origin, country)
    if city:
        if supplied and supplied != city["timezone"]:
            raise ValueError("Timezone does not match the departure city")
        return city["timezone"]
    return supplied or "UTC"


def search_aliases(value: str) -> tuple[list[str], str | None]:
    city = resolve(value)
    values = aliases(city) if city else [value]
    # PostgreSQL lower() and Unicode casefold() differ for Armenian ligatures.
    return sorted({a.strip().lower() for a in values}), city["country"] if city else None
