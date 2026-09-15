import asyncio
import hashlib
import logging

from fastapi import Request

from armeniabus.api.errors import ApiError

logger = logging.getLogger(__name__)

_INCREMENT_WITH_TTL = """
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
"""


async def enforce_auth_rate_limit(request: Request, operation: str, identity: str = "") -> None:
    client_host = request.client.host if request.client else "unknown"
    keys = [f"auth:rate:{operation}:ip:{hashlib.sha256(client_host.encode()).hexdigest()}"]
    if identity:
        keys.append(f"auth:rate:{operation}:account:{hashlib.sha256(identity.encode()).hexdigest()}")
    try:
        for key in keys:
            count = await asyncio.wait_for(
                request.app.state.redis.eval(_INCREMENT_WITH_TTL, 1, key, 60), timeout=2
            )
            if count > request.app.state.settings.auth_rate_limit_per_minute:
                raise ApiError(429, "RATE_LIMITED", "Too many requests; try again later")
    except ApiError:
        raise
    except Exception:
        logger.warning("Authentication rate limiter unavailable")
        raise ApiError(503, "DEPENDENCY_UNAVAILABLE", "Service is not ready") from None
