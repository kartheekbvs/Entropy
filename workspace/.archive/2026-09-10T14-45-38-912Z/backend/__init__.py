"""ModelForge — ML model hosting platform.

Turns trained scikit-learn / joblib pipelines (``.pkl``) into secured,
observable, real-time prediction APIs:

* upload a model -> auto-validated & task-detected
* issue purpose-scoped API keys (predict / batch / analytics)
* serve predictions behind a per-key rate limiter
* stream every event over a WebSocket (``/ws``) telemetry channel

Package layout::

    backend.config       environment-driven settings (12-factor)
    backend.errors       typed error taxonomy + global handlers
    backend.schemas      pydantic v2 request/response contracts
    backend.store        thread-safe catalog with JSON snapshot persistence
    backend.predictor    joblib loading, task detection, safe prediction
    backend.cache        bounded LRU predictor cache
    backend.security     API-key minting & validation
    backend.rate_limit   per-key sliding-window limiter
    backend.realtime     WebSocket event hub (seq + replay)
    backend.routers      HTTP/WS route modules
    backend.main         ASGI application factory
"""

__version__ = "2.0.0"

__all__ = ["__version__"]
