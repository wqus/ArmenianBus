from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel


class ErrorBody(BaseModel):
    code: str
    message: str
    request_id: str
    details: Any | None = None


class ApiError(Exception):
    def __init__(self, status_code: int, code: str, message: str, details: Any = None):
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def error_response(request: Request, status: int, code: str, message: str, details=None):
    return JSONResponse(
        status_code=status,
        content=ErrorBody(
            code=code,
            message=message,
            request_id=request.state.request_id,
            details=details,
        ).model_dump(),
    )


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def api_error(request: Request, exc: ApiError):
        return error_response(request, exc.status_code, exc.code, exc.message, exc.details)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        details = [
            {"field": ".".join(map(str, error["loc"])), "message": error["msg"]}
            for error in exc.errors()
        ]
        return error_response(request, 422, "VALIDATION_ERROR", "Invalid request", details)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return error_response(request, exc.status_code, "HTTP_ERROR", str(exc.detail))
