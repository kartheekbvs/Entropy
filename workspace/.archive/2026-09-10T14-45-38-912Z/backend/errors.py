"""Typed error taxonomy + global exception handlers.

Every failure leaving the API has the same wire shape::

    {"error": {"code": "model_not_found", "message": "...", "request_id": "..."}}

so clients (and our own frontend) can branch on ``code`` instead of parsing
prose. Handlers are registered by :func:`register_error_handlers` on the app
factory; they cover this module's exceptions, ``HTTPException``,
``RequestValidationError`` and a catch-all 500.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.logging_conf import new_request_id

logger = logging.getLogger("modelforge.errors")


class ModelForgeError(Exception):
    """Base class for all expected, domain-level failures."""

    status_code: int = 500
    code: str = "internal_error"

    def __init__(self, message: str, *, code: str | None = None, status_code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code


class ModelNotFoundError(ModelForgeError):
    status_code, code = 404, "model_not_found"


class KeyNotFoundError(ModelForgeError):
    status_code, code = 404, "key_not_found"


class InvalidModelFileError(ModelForgeError):
    status_code, code = 422, "invalid_model_file"


class UnsupportedFileError(ModelForgeError):
    status_code, code = 400, "unsupported_file_type"


class PayloadTooLargeError(ModelForgeError):
    status_code, code = 413, "payload_too_large"


class AuthenticationError(ModelForgeError):
    status_code, code = 401, "authentication_required"


class AuthorizationError(ModelForgeError):
    status_code, code = 403, "forbidden"


class RateLimitExceededError(ModelForgeError):
    status_code, code = 429, "rate_limit_exceeded"

    def __init__(self, message: str, *, retry_after_s: int = 60) -> None:
        super().__init__(message)
        self.retry_after_s = retry_after_s


class PredictionFailedError(ModelForgeError):
    status_code, code = 422, "prediction_failed"


def error_response(
    status_code: int,
    code: str,
    message: str,
    request_id: str | None = None,
    *,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    """Uniform error envelope used by every handler."""
    return JSONResponse(
        status_code=status_code,
        headers=headers,
        content={
            "error": {
                "code": code,
                "message": message,
                "request_id": request_id or new_request_id(),
            }
        },
    )


def register_error_handlers(app: FastAPI) -> None:
    """Attach all global exception handlers to an application instance."""

    @app.exception_handler(ModelForgeError)
    async def _domain_handler(request: Request, exc: ModelForgeError) -> JSONResponse:
        rid = request.state.request_id if hasattr(request.state, "request_id") else None
        headers = None
        if isinstance(exc, RateLimitExceededError):
            headers = {"Retry-After": str(exc.retry_after_s)}
        logger.warning("domain_error code=%s status=%s detail=%s", exc.code, exc.status_code, exc.message)
        return error_response(exc.status_code, exc.code, exc.message, rid, headers=headers)

    @app.exception_handler(StarletteHTTPException)
    async def _http_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        rid = request.state.request_id if hasattr(request.state, "request_id") else None
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return error_response(exc.status_code, code, str(exc.detail), rid)

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        rid = request.state.request_id if hasattr(request.state, "request_id") else None
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(p) for p in first.get("loc", [])) or "body"
        message = f"Invalid request at '{loc}': {first.get('msg', 'validation failed')}"
        return error_response(422, "validation_error", message, rid)

    @app.exception_handler(Exception)
    async def _unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
        rid = request.state.request_id if hasattr(request.state, "request_id") else None
        logger.exception("unhandled_error request_id=%s", rid)
        return error_response(500, "internal_error", "An unexpected error occurred.", rid)
