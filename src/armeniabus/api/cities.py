from typing import Annotated, Literal

from fastapi import APIRouter, Query

from armeniabus.modules.cities.catalog import CITIES, aliases, normalized

router = APIRouter(prefix="/api/v1/cities", tags=["cities"])


@router.get("")
def cities(
    q: Annotated[str, Query(max_length=200)] = "",
    country: Literal["RU", "AM"] | None = None,
):
    key = normalized(q)
    return {
        "items": [
            city
            for city in CITIES
            if (not country or city["country"] == country)
            and (not key or any(key in normalized(a) for a in aliases(city)))
        ]
    }
