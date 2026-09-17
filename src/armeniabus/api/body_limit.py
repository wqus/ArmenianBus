import asyncio

from starlette.requests import Request

from armeniabus.api.errors import error_response


class _BodyTooLarge(Exception):
    pass


class BodyLimitMiddleware:
    """Bound JSON request buffering, including requests without Content-Length."""

    def __init__(self, app, max_bytes: int, timeout_seconds: int):
        self.app, self.max_bytes, self.timeout_seconds = app, max_bytes, timeout_seconds

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request = Request(scope)
        length = request.headers.get("content-length")
        if length is not None and (not length.isascii() or not length.isdecimal()):
            return await error_response(
                request, 400, "INVALID_CONTENT_LENGTH", "Invalid request size"
            )(scope, receive, send)
        if length is not None and (len(length) > 10 or int(length) > self.max_bytes):
            return await error_response(
                request, 413, "REQUEST_TOO_LARGE", "Request exceeds size limit"
            )(scope, receive, send)
        body = bytearray()
        try:
            async with asyncio.timeout(self.timeout_seconds):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    chunk = message.get("body", b"")
                    if len(body) + len(chunk) > self.max_bytes:
                        raise _BodyTooLarge
                    body.extend(chunk)
                    if not message.get("more_body", False):
                        break
        except _BodyTooLarge:
            return await error_response(
                request, 413, "REQUEST_TOO_LARGE", "Request exceeds size limit"
            )(scope, receive, send)
        except TimeoutError:
            return await error_response(request, 408, "REQUEST_TIMEOUT", "Request body timed out")(
                scope, receive, send
            )
        consumed = False

        async def replay():
            nonlocal consumed
            if not consumed:
                consumed = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)
