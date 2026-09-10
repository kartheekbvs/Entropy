"""API key lifecycle: create, list, revoke."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends

from backend.dependencies import get_hub, get_store
from backend.errors import KeyNotFoundError, ModelNotFoundError
from backend.realtime import RealtimeHub
from backend.schemas import CreateKeyRequest, KeyCreatedResponse, KeyListResponse, RevokeKeyResponse
from backend.security import build_key
from backend.store import Storage, utcnow_iso

logger = logging.getLogger("modelforge.keys")
router = APIRouter(prefix="/api", tags=["keys"])


@router.post("/keys", response_model=KeyCreatedResponse, status_code=201)
def create_key(
    req: CreateKeyRequest,
    store: Storage = Depends(get_store),
    hub: RealtimeHub = Depends(get_hub),
) -> KeyCreatedResponse:
    """Mint a new purpose-scoped key for a model."""
    model = store.get_model(req.model_id)
    if not model:
        raise ModelNotFoundError(f"Model {req.model_id} not found")

    key = store.register_key(
        build_key(
            model_id=req.model_id,
            purpose=req.purpose,
            label=(req.label or f"Key for {model.name} ({req.purpose})")[:120],
            created_at=utcnow_iso(),
        )
    )
    store.persist()
    hub.publish("key.created", {
        "key_id": key.id,
        "model_id": key.model_id,
        "purpose": key.purpose,
        "label": key.label,
    })
    logger.info("key_created id=%s model=%s purpose=%s", key.id, key.model_id, key.purpose)
    return KeyCreatedResponse(**_key_view(key))


@router.get("/keys", response_model=KeyListResponse)
def list_keys(model_id: str, store: Storage = Depends(get_store)) -> KeyListResponse:
    """List every key belonging to a model (newest last)."""
    keys = store.list_keys(model_id)
    return KeyListResponse(count=len(keys), keys=[_key_view(k) for k in keys])  # type: ignore[arg-type]


@router.delete("/keys/{key_id}", response_model=RevokeKeyResponse)
def revoke_key(
    key_id: str,
    store: Storage = Depends(get_store),
    hub: RealtimeHub = Depends(get_hub),
) -> RevokeKeyResponse:
    """Revoke a key — immediate, permanent, but the record stays auditable."""
    key = store.revoke_key(key_id)
    if not key:
        raise KeyNotFoundError(f"API key {key_id} not found")
    store.persist()
    hub.publish("key.revoked", {"key_id": key_id, "model_id": key.model_id})
    logger.info("key_revoked id=%s model=%s", key_id, key.model_id)
    return RevokeKeyResponse(message="API key revoked", key_id=key_id)


def _key_view(key) -> dict:
    return {
        "id": key.id,
        "key": key.key,
        "model_id": key.model_id,
        "purpose": key.purpose,
        "label": key.label,
        "created_at": key.created_at,
        "request_count": key.request_count,
        "is_active": key.is_active,
    }
