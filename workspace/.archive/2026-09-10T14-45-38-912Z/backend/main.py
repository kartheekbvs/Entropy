"""ModelForge ASGI application.

Exposes:

* :func:`create_app` — testable application factory (per-app state, no globals)
* module-level ``app`` — the instance uvicorn serves (``backend.main:app``)
* :func:`run` — console entry point with the documented defaults

The lifespan seeds the bundled demo model on first boot (unless
``MODELFORGE_SEED_DEMO=0``), starts the realtime hub heartbeat, and snapshots
the catalog on shutdown so restarts are non-destructive.
"""

from __future__ import annotations

import logging
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

import backend
from backend.cache import PredictorCache
from backend.config import Settings, settings_from_env
from backend.errors import register_error_handlers
from backend.logging_conf import configure_logging, new_request_id, request_id_var
from backend.rate_limit import RateLimiter
from backend.realtime import RealtimeHub
from backend.routers import keys, models, pages, predict, stats, ws
from backend.security import build_key
from backend.store import Model, Storage, utcnow_iso

logger = logging.getLogger("modelforge.main")

DESCRIPTION = """
Turn trained ML models into **production APIs in seconds**.

* Upload a `.pkl` artifact — auto-validated, task-detected, served warm from an LRU cache
* Mint purpose-scoped API keys (predict / batch / analytics) with per-key rate limiting
* Predict over REST with latency telemetry, and watch everything live on the
  **real-time WebSocket channel** (`/ws`)

Every failure returns a typed envelope: `{"error": {"code", "message", "request_id"}}`.
"""

TAGS_METADATA = [
    {"name": "models", "description": "Upload, list and delete hosted models."},
    {"name": "keys", "description": "Create, list and revoke API keys."},
    {"name": "predict", "description": "Run predictions and read logs."},
    {"name": "observability", "description": "Dashboard stats and health probes."},
    {"name": "realtime", "description": "WebSocket event stream."},
    {"name": "pages", "description": "HTML pages (hidden from schema)."},
]


def _seed_demo_model(settings: Settings, store: Storage, cache: PredictorCache) -> None:
    """Load the bundled spam classifier so the landing demo works out of the box."""
    if not settings.seed_demo:
        return
    if store.list_models():  # operator already uploaded something — stay quiet
        return

    from backend.predictor import load_predictor_safely

    demo_pkl = settings.demo_models_dir / "spam_classifier.pkl"
    demo_meta = settings.demo_models_dir / "spam_classifier.meta.json"
    if not demo_pkl.exists():
        logger.warning("demo_model_missing path=%s", demo_pkl)
        return

    model_id = "model_demo_spam_classifier"
    target = settings.storage_dir / f"{model_id}.pkl"
    shutil.copyfile(demo_pkl, target)
    if demo_meta.exists():
        shutil.copyfile(demo_meta, settings.storage_dir / f"{model_id}.meta.json")

    try:
        predictor = load_predictor_safely(str(target), "classification")
    except Exception as exc:  # noqa: BLE001
        logger.warning("demo_model_invalid err=%s", exc)
        target.unlink(missing_ok=True)
        return

    store.add_model(
        Model(
            id=model_id,
            name="Spam Classifier (demo)",
            filename="spam_classifier.pkl",
            pkl_path=str(target),
            description="Bundled demo: TF-IDF + Naive Bayes text classifier. Included so the live console works on first boot.",
            task_type=predictor.task_type,
            uploaded_at=utcnow_iso(),
            size_bytes=target.stat().st_size,
            class_labels=predictor.class_labels,
            feature_count=predictor.feature_count,
        )
    )
    store.register_key(
        build_key(
            model_id=model_id,
            purpose="predict",
            label="Spam Classifier — Demo Key",
            created_at=utcnow_iso(),
        )
    )
    cache.put(model_id, predictor)
    store.persist()
    logger.info("demo_model_seeded id=%s", model_id)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Startup: seed + start hub. Shutdown: flush snapshot + close sockets."""
    settings: Settings = app.state.settings
    hub: RealtimeHub = app.state.hub

    _seed_demo_model(settings, app.state.store, app.state.cache)
    hub._stats_provider = lambda: app.state.store.stats(connected_clients=hub.client_count())
    await hub.start()
    logger.info(
        "startup version=%s env=%s port=%s storage=%s",
        backend.__version__, settings.env, settings.port, settings.storage_dir,
    )
    try:
        yield
    finally:
        await hub.stop()
        app.state.store.persist()
        logger.info("shutdown snapshot_flushed")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build a fully-wired application instance (isolated state per app)."""
    settings = settings or settings_from_env()
    logger = configure_logging(settings.log_level)

    app = FastAPI(
        title="ModelForge API",
        description=DESCRIPTION,
        version=backend.__version__,
        lifespan=lifespan,
        openapi_tags=TAGS_METADATA,
        docs_url="/docs",
        redoc_url="/redoc",
        license_info={"name": "MIT", "url": "https://opensource.org/licenses/MIT"},
        contact={"name": "ModelForge Contributors"},
    )

    # ── app state singletons ─────────────────────────────────────────────
    app.state.settings = settings
    app.state.store = Storage(settings.state_dir, history_limit=settings.history_limit)
    app.state.cache = PredictorCache(capacity=settings.max_cached_models)
    app.state.limiter = RateLimiter(settings.rate_limit_per_min)
    app.state.hub = RealtimeHub()

    # ── middleware (outermost first) ─────────────────────────────────────
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["*"],
            allow_headers=["*"],
            expose_headers=["X-Request-ID"],
        )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        """Correlate every request with an id and log slow responses."""
        rid = request.headers.get("X-Request-ID") or new_request_id()
        request_id_var.set(rid)
        request.state.request_id = rid
        started = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            request_id_var.set("-")
        response.headers["X-Request-ID"] = rid
        elapsed = (time.perf_counter() - started) * 1000
        if elapsed > 800:  # pragma: no cover - slow-path visibility
            logger.warning(
                "slow_request method=%s path=%s elapsed_ms=%.0f",
                request.method, request.url.path, elapsed,
            )
        return response

    register_error_handlers(app)

    # ── routes ───────────────────────────────────────────────────────────
    for module in (pages, models, keys, predict, stats, ws):
        app.include_router(module.router)

    app.mount("/static", StaticFiles(directory=str(settings.static_dir)), name="static")
    app.mount("/js", StaticFiles(directory=str(settings.frontend_dir / "js")), name="js")

    return app


# Instance served by:  uvicorn backend.main:app --port 4500
app = create_app()


def run() -> None:  # pragma: no cover - console entry point
    """Console entry point (``modelforge`` / ``python -m backend.main``)."""
    import uvicorn

    settings = settings_from_env()
    uvicorn.run(
        "backend.main:app",
        host=settings.host,
        port=settings.port,
        reload=not settings.is_production,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":  # pragma: no cover
    run()
