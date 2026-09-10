"""Model lifecycle routes: upload, list, delete."""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, UploadFile

from backend.cache import PredictorCache
from backend.config import Settings
from backend.dependencies import get_cache, get_settings, get_store, get_hub
from backend.errors import (
    InvalidModelFileError,
    ModelNotFoundError,
    PayloadTooLargeError,
    UnsupportedFileError,
)
from backend.predictor import load_predictor_safely
from backend.realtime import RealtimeHub
from backend.schemas import DeleteModelResponse, ModelListResponse, UploadResponse
from backend.security import build_key
from backend.store import Storage, Model, new_model_id, utcnow_iso

logger = logging.getLogger("modelforge.models")
router = APIRouter(prefix="/api", tags=["models"])


def _sanitize_upload_name(name: str) -> str:
    cleaned = (name or "").strip()
    return cleaned[:120] or "unnamed-model"


@router.post("/upload", response_model=UploadResponse, status_code=201)
async def upload_model(
    file: UploadFile = File(..., description="Trained model artifact (.pkl)."),
    name: str = Form(..., description="Human-readable model name."),
    description: str = Form(""),
    task_type: str = Form("unknown"),
    store: Storage = Depends(get_store),
    hub: RealtimeHub = Depends(get_hub),
    cache: PredictorCache = Depends(get_cache),
    settings: Settings = Depends(get_settings),
) -> UploadResponse:
    """Upload a ``.pkl`` model, validate it, and mint a default API key.

    The artifact is written atomically (tmp + rename) and **must deserialize
    and expose ``predict``** — invalid files are rejected with 422 and fully
    cleaned up, so the catalog only ever contains working models.
    """
    filename = file.filename or "model.pkl"
    if not filename.lower().endswith(".pkl"):
        raise UnsupportedFileError("Only .pkl files are supported")

    content = await file.read()
    if not content:
        raise InvalidModelFileError("Uploaded file is empty")
    if len(content) > settings.max_upload_bytes:
        raise PayloadTooLargeError(f"Model exceeds the {settings.max_upload_mb} MB upload limit")

    model_id = new_model_id(filename)
    pkl_path = Path(settings.storage_dir) / f"{model_id}.pkl"
    tmp_path = pkl_path.with_suffix(".pkl.tmp")
    try:
        tmp_path.write_bytes(content)
        os.replace(tmp_path, pkl_path)

        predictor = load_predictor_safely(str(pkl_path), task_type)
    except Exception as exc:  # noqa: BLE001
        for leftover in (tmp_path, pkl_path):
            try:
                leftover.unlink(missing_ok=True)
            except OSError:  # pragma: no cover
                pass
        raise InvalidModelFileError(f"Model failed validation: {exc}") from exc

    display_name = _sanitize_upload_name(name)
    model = Model(
        id=model_id,
        name=display_name,
        filename=filename,
        pkl_path=str(pkl_path),
        description=(description or "").strip()[:2000],
        task_type=predictor.task_type,
        uploaded_at=utcnow_iso(),
        size_bytes=len(content),
        class_labels=predictor.class_labels,
        feature_count=predictor.feature_count,
    )
    store.add_model(model)
    cache.put(model_id, predictor)

    default_key = store.register_key(
        build_key(
            model_id=model_id,
            purpose="predict",
            label=f"{display_name} — Default Key",
            created_at=utcnow_iso(),
        )
    )
    store.persist()

    hub.publish("model.uploaded", {
        "model_id": model_id,
        "name": display_name,
        "task_type": model.task_type,
        "size_bytes": model.size_bytes,
    })
    logger.info(
        "model_uploaded id=%s name=%s task=%s bytes=%d",
        model_id, display_name, model.task_type, len(content),
    )

    return UploadResponse(
        model_id=model_id,
        name=display_name,
        task_type=model.task_type,
        feature_count=predictor.feature_count,
        class_labels=predictor.class_labels,
        message=f"Model uploaded successfully. Default API key: {default_key.key}",
    )


@router.get("/models", response_model=ModelListResponse)
def list_models(store: Storage = Depends(get_store)) -> ModelListResponse:
    """List every hosted model with live usage statistics."""
    models = store.list_models()
    return ModelListResponse(
        count=len(models),
        models=[m.to_public() for m in models],  # type: ignore[arg-type]
    )


@router.delete("/models/{model_id}", response_model=DeleteModelResponse)
def delete_model(
    model_id: str,
    store: Storage = Depends(get_store),
    hub: RealtimeHub = Depends(get_hub),
    cache: PredictorCache = Depends(get_cache),
) -> DeleteModelResponse:
    """Delete a model, its keys, its logs and its artifact from disk."""
    model = store.get_model(model_id)
    if not model:
        raise ModelNotFoundError(f"Model {model_id} not found")

    cache.discard(model_id)
    try:
        Path(model.pkl_path).unlink(missing_ok=True)
    except OSError as exc:  # pragma: no cover - fs failure shouldn't block
        logger.warning("artifact_unlink_failed id=%s err=%s", model_id, exc)

    deleted, removed_keys = store.delete_model(model_id)
    store.persist()
    hub.publish("model.deleted", {"model_id": model_id, "removed_keys": removed_keys})
    logger.info("model_deleted id=%s removed_keys=%d", model_id, removed_keys)
    return DeleteModelResponse(message=f"Model {model_id} deleted", deleted_keys=removed_keys)
