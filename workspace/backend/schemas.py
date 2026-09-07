"""Pydantic v2 request/response contracts.

These models are the single source of truth for the OpenAPI schema rendered at
``/docs``: every route declares its request and response model here, which
guarantees the documented contract and the served payloads can never drift.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ModelInfo(BaseModel):
    """A hosted model as exposed by ``GET /api/models``."""

    id: str = Field(..., description="Unique model identifier used in URLs.")
    name: str = Field(..., description="Human-readable name given at upload.")
    task_type: str = Field("unknown", description="classification | regression | clustering | unknown.")
    description: str = Field("", description="Free-form notes supplied at upload.")
    uploaded_at: str = Field(..., description="ISO-8601 UTC upload timestamp.")
    size_bytes: int = Field(0, description="Artifact size on disk.")
    request_count: int = Field(0, description="Total successful predictions served.")
    class_labels: list[str] | None = Field(None, description="Detected class labels, when available.")
    feature_count: int | None = Field(None, description="Expected number of input features.")
    latency_avg_ms: float | None = Field(None, description="Mean latency over recent requests, ms.")


class ModelListResponse(BaseModel):
    count: int
    models: list[ModelInfo]


class UploadResponse(BaseModel):
    model_id: str
    name: str
    task_type: str
    feature_count: int | None = None
    class_labels: list[str] | None = None
    message: str


class CreateKeyRequest(BaseModel):
    model_id: str = Field(..., min_length=1, description="Model the key unlocks.")
    purpose: Literal["predict", "batch", "analytics"] = Field("predict", description="Key scope.")
    label: str = Field("", max_length=120, description="Human-readable key label.")


class KeyInfo(BaseModel):
    id: str
    key: str = Field(..., description="Secret — shown once at creation, stored for self-hosted convenience.")
    model_id: str
    purpose: str
    label: str
    created_at: str
    request_count: int
    is_active: bool


class KeyListResponse(BaseModel):
    count: int
    keys: list[KeyInfo]


class KeyCreatedResponse(KeyInfo):
    message: str = Field("Store this key securely — it will not be shown again.")


class PredictRequest(BaseModel):
    """Prediction input.

    ``data`` accepts either a flat list (one sample) or a list of lists
    (batch), with numbers or strings (text pipelines). The predictor layer
    performs the numpy/shape adaptation.
    """

    data: list[Any] = Field(..., min_length=1, description="Feature values, a sample, or a batch of samples.")

    @field_validator("data")
    @classmethod
    def _reject_empty_nested(cls, v: list[Any]) -> list[Any]:
        if isinstance(v, list) and len(v) == 0:
            raise ValueError("data must not be empty")
        return v


class PredictResponse(BaseModel):
    model_id: str
    model_name: str
    prediction: Any
    raw_output: Any
    task_type: str
    class_labels: list[str] | None = None
    latency_ms: float
    timestamp: str


class PredictionLogEntry(BaseModel):
    id: str
    input_data: str
    prediction: str
    latency_ms: float
    timestamp: str
    success: bool
    error: str


class PredictionLogResponse(BaseModel):
    count: int
    logs: list[PredictionLogEntry]


class StatsResponse(BaseModel):
    total_models: int
    total_api_keys: int
    active_api_keys: int
    total_requests: int
    avg_latency_ms: float | None
    connected_clients: int
    models: list[ModelInfo]
    recent_logs: list[PredictionLogEntry]


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    env: str
    uptime_s: float
    models: int
    connected_clients: int
    timestamp: str


class MessageResponse(BaseModel):
    message: str


class DeleteModelResponse(MessageResponse):
    deleted_keys: int


class RevokeKeyResponse(MessageResponse):
    key_id: str
