"""API key lifecycle and auth contract."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_upload_mints_default_key(client: TestClient, uploaded_model):
    model_id, _ = uploaded_model
    keys = client.get("/api/keys", params={"model_id": model_id}).json()
    assert keys["count"] >= 1
    key = keys["keys"][0]
    assert key["purpose"] == "predict"
    assert key["is_active"] is True
    assert key["key"].startswith("mf_") and len(key["key"]) == 35  # mf_ + 32 hex


def test_create_key_scopes_and_labels(client: TestClient, uploaded_model):
    model_id, _ = uploaded_model
    res = client.post(
        "/api/keys",
        json={"model_id": model_id, "purpose": "analytics", "label": "Prod Analytics"},
    )
    assert res.status_code == 201
    body = res.json()
    assert body["purpose"] == "analytics"
    assert body["label"] == "Prod Analytics"
    assert "will not be shown again" in body["message"]


def test_create_key_for_missing_model(client: TestClient):
    res = client.post("/api/keys", json={"model_id": "missing", "purpose": "predict"})
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "model_not_found"


def test_create_key_rejects_bad_purpose(client: TestClient, uploaded_model):
    model_id, _ = uploaded_model
    res = client.post("/api/keys", json={"model_id": model_id, "purpose": "admin"})
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "validation_error"


def test_revoke_key_blocks_prediction(client: TestClient, uploaded_model):
    model_id, key = uploaded_model
    keys = client.get("/api/keys", params={"model_id": model_id}).json()["keys"]
    key_id = keys[0]["id"]

    ok = client.post(
        f"/api/predict/{model_id}",
        headers={"X-API-Key": key},
        json={"data": ["Hello there friend"]},
    )
    assert ok.status_code == 200

    revoked = client.delete(f"/api/keys/{key_id}")
    assert revoked.status_code == 200

    blocked = client.post(
        f"/api/predict/{model_id}",
        headers={"X-API-Key": key},
        json={"data": ["Hello there friend"]},
    )
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "forbidden"


def test_revoke_missing_key(client: TestClient):
    assert client.delete("/api/keys/zzz").status_code == 404


def test_key_format_is_minted_with_csprng_shape(client: TestClient, uploaded_model):
    model_id, _ = uploaded_model
    keys = client.get("/api/keys", params={"model_id": model_id}).json()["keys"]
    import re

    assert re.match(r"^mf_[0-9a-f]{32}$", keys[0]["key"])
