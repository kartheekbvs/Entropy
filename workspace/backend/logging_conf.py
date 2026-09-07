"""Structured logging and request correlation.

Design goals:

* one JSON line per event — trivially ingestible by any log pipeline
* every request carries an ``X-Request-ID`` (accepted from upstream, minted
  otherwise) and every response echoes it, so a support ticket maps to exact
  log lines
* third-party loggers are left at WARNING so uvicorn/access noise stays out of
  the application channel
"""

from __future__ import annotations

import json
import logging
import sys
import time
import uuid
from contextvars import ContextVar

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")

_CONFIGURED = False


class JsonFormatter(logging.Formatter):
    """Render each record as a single JSON object."""

    def format(self, record: logging.LogRecord) -> str:  # noqa: D102
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": request_id_var.get(),
        }
        if record.exc_info and record.exc_info[0] is not None:
            payload["exc"] = self.formatException(record.exc_info)[-2000:]
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(level: str = "INFO") -> logging.Logger:
    """Idempotently install the JSON handler and return the app logger."""
    global _CONFIGURED
    logger = logging.getLogger("modelforge")
    if _CONFIGURED:
        logger.setLevel(level.upper())
        return logger

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.WARNING)

    logger.setLevel(level.upper())
    logger.addHandler(handler)
    logger.propagate = False

    for noisy in ("uvicorn.access", "websockets", "multipart"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _CONFIGURED = True
    return logger


def new_request_id() -> str:
    """Mint a short, log-friendly correlation id."""
    return uuid.uuid4().hex[:12]
