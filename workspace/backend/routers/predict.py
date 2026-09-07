"""Prediction + log routes: the hot path.

Flow: authenticate key -> authorize for this model -> consume rate-limit
budget -> cache-warm predictor -> predict -> log + broadcast -> respond.
Failures are logged and broadcast too (``prediction.failed``) so dashboards
see the true error rate in real time, then surfaced as typed 422s.
"""

from __future__ import annotations

import json
import logging
import time

from fastapi import APIRouter, Depends, Header, Query

from backend.cache import PredictorCache, cached_predictor
from backend.dependencies import get_cache, get_hub, get_limiter, get_store
from backend.errors import (
    AuthorizationError,
    ModelNotFoundError,
    PredictionFailedError,
    RateLimitExceededError,
)
from backend.predictor import ModelPredictor, ModelValidationError
from backend.rate_limit import RateLimiter
from backend.realtime import RealtimeHub
from backend.schemas import PredictRequest, PredictResponse, PredictionLogResponse
from backend.security import validate_key
from backend.store import PredictionLog, Storage, utcnow_iso

logger = logging.getLogger("modelforge.predict")
router = APIRouter(prefix="/api", tags=["predict"])


@router.post("/predict/{model_id}", response_model=PredictResponse)
def predict(
    model_id: str,
    req: PredictRequest,
    x_api_key: str = Header(None, alias="X-API-Key"),
    store: Storage = Depends(get_store),
    hub: RealtimeHub = Depends(get_hub),
    cache: PredictorCache = Depends(get_cache),
    limiter: RateLimiter = Depends(get_limiter),
) -> PredictResponse:
    """Run one prediction against a hosted model."""
    api_key = validate_key(store, x_api_key, model_id=model_id)

    allowed, retry_after = limiter.check(api_key.id)
    if not allowed:
        raise RateLimitExceededError(
            f"Rate limit exceeded ({limiter.limit} requests/minute). Retry in {retry_after}s.",
            retry_after_s=retry_after,
        )

    model = store.get_model(model_id)
    if not model:  # pragma: no cover - validate_key already guards this
        raise ModelNotFoundError(f"Model {model_id} not found")

    def _loader() -> ModelPredictor:
        predictor = ModelPredictor(model.pkl_path, model.task_type)
        try:
            predictor.load()
        except ModelValidationError as exc:
            raise PredictionFailedError(f"Model artifact is no longer loadable: {exc}") from exc
        return predictor

    try:
        predictor = cached_predictor(cache, model_id, _loader)
    except PredictionFailedError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise PredictionFailedError(f"Could not load model: {exc}") from exc

    started = time.perf_counter()
    result = predictor.predict(req.data)
    latency_ms = round((time.perf_counter() - started) * 1000, 2)

    log = store.add_log(
        PredictionLog(
            id="",
            model_id=model_id,
            api_key_id=api_key.id,
            input_data=json.dumps(req.data)[:4000],
            output_data=json.dumps(result.get("raw_output"), default=str)[:4000] if result.get("raw_output") is not None else "",
            prediction=str(result.get("prediction", ""))[:1000],
            latency_ms=latency_ms,
            timestamp=utcnow_iso(),
            success=bool(result.get("success")),
            error_message=(result.get("error") or "")[:1000],
        )
    )
    if result.get("success"):
        store.record_latency(model_id, latency_ms)
    store.record_key_request(api_key.id)
    store.maybe_persist()

    hub.publish(
        "prediction.completed" if result.get("success") else "prediction.failed",
        {
            "model_id": model_id,
            "model_name": model.name,
            "prediction": str(result.get("prediction", ""))[:200],
            "latency_ms": latency_ms,
            "success": bool(result.get("success")),
            "error": (result.get("error") or "")[:200],
        },
    )

    if not result.get("success"):
        raise PredictionFailedError(result.get("error") or "Prediction failed")

    return PredictResponse(
        model_id=model_id,
        model_name=model.name,
        prediction=result["prediction"],
        raw_output=result.get("raw_output"),
        task_type=result.get("task_type", "unknown"),
        class_labels=result.get("class_labels"),
        latency_ms=latency_ms,
        timestamp=log.timestamp,
    )


@router.get("/logs/{model_id}", response_model=PredictionLogResponse)
def get_prediction_logs(
    model_id: str,
    limit: int = Query(100, ge=1, le=500),
    store: Storage = Depends(get_store),
) -> PredictionLogResponse:
    """Recent prediction history for one model."""
    model = store.get_model(model_id)
    if not model:
        raise ModelNotFoundError(f"Model {model_id} not found")
    logs = store.get_logs(model_id, limit)
    return PredictionLogResponse(
        count=len(logs),
        logs=[
            {
                "id": l.id,
                "input_data": l.input_data,
                "prediction": l.prediction,
                "latency_ms": l.latency_ms,
                "timestamp": l.timestamp,
                "success": l.success,
                "error": l.error_message,
            }
            for l in logs
        ],  # type: ignore[arg-type]
    )
