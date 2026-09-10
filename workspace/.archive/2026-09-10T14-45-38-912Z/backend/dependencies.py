"""FastAPI dependency accessors for app-state singletons.

The app factory (``backend.main.create_app``) builds the store, hub, cache,
limiter and settings once and hangs them off ``app.state``. These accessors
keep routers testable (override with ``app.dependency_overrides``) and free
of import-time globals.
"""

from __future__ import annotations

from fastapi import Request

from backend.cache import PredictorCache
from backend.config import Settings
from backend.rate_limit import RateLimiter
from backend.realtime import RealtimeHub
from backend.store import Storage


def get_settings(request: Request) -> Settings:
    return request.app.state.settings  # type: ignore[no-any-return]


def get_store(request: Request) -> Storage:
    return request.app.state.store  # type: ignore[no-any-return]


def get_hub(request: Request) -> RealtimeHub:
    return request.app.state.hub  # type: ignore[no-any-return]


def get_cache(request: Request) -> PredictorCache:
    return request.app.state.cache  # type: ignore[no-any-return]


def get_limiter(request: Request) -> RateLimiter:
    return request.app.state.limiter  # type: ignore[no-any-return]
