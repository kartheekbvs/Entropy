"""Observability routes: dashboard stats, health, rate-limit snapshot."""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends

import backend
from backend.config import Settings
from backend.dependencies import get_hub, get_limiter, get_settings, get_store
from backend.rate_limit import RateLimiter
from backend.realtime import RealtimeHub
from backend.schemas import HealthResponse, StatsResponse
from backend.store import Storage

router = APIRouter(prefix="/api", tags=["observability"])


@router.get("/dashboard", response_model=StatsResponse)
def dashboard_stats(
    store: Storage = Depends(get_store),
    hub: RealtimeHub = Depends(get_hub),
) -> StatsResponse:
    """Aggregate usage stats for the dashboard (also pushed over /ws)."""
    return StatsResponse(**store.stats(connected_clients=hub.client_count()))


@router.get("/health", response_model=HealthResponse)
def health(
    store: Storage = Depends(get_store),
    hub: RealtimeHub = Depends(get_hub),
    settings: Settings = Depends(get_settings),
) -> HealthResponse:
    """Liveness/readiness probe for orchestrators (Docker, k8s, uptime bots)."""
    return HealthResponse(
        status="ok",
        version=backend.__version__,
        env=settings.env,
        uptime_s=round(time.monotonic() - _START_TIME, 1),
        models=len(store.list_models()),
        connected_clients=hub.client_count(),
        timestamp=time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
    )


@router.get("/rate-limits")
def rate_limits(limiter: RateLimiter = Depends(get_limiter)) -> dict:
    """Current per-key usage inside the active window (admin/debug)."""
    return {
        "limit_per_minute": limiter.limit,
        "active_keys": limiter.snapshot(),
    }


_START_TIME = time.monotonic()
