"""HTTP + WebSocket route modules (registered by ``backend.main.create_app``)."""

from backend.routers import keys, models, pages, predict, stats, ws  # noqa: F401

__all__ = ["models", "keys", "predict", "stats", "pages", "ws"]
