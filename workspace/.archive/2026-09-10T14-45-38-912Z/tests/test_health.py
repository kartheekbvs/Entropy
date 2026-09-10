"""Health, observability and error-contract tests."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_health_ok(client: TestClient):
    res = client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["version"] == "2.0.0"
    assert body["env"] == "development"
    assert body["models"] == 0
    assert body["uptime_s"] >= 0
    assert "timestamp" in body


def test_request_id_header_is_set_and_echoed(client: TestClient):
    res = client.get("/api/health", headers={"X-Request-ID": "fixed-req-42"})
    assert res.headers.get("X-Request-ID") == "fixed-req-42"


def test_dashboard_empty_state(client: TestClient):
    res = client.get("/api/dashboard")
    assert res.status_code == 200
    body = res.json()
    assert body["total_models"] == 0
    assert body["total_requests"] == 0
    assert body["avg_latency_ms"] is None
    assert body["models"] == []


def test_404_uses_typed_error_envelope(client: TestClient):
    res = client.get("/api/models/does_not_exist_xyz", )
    assert res.status_code in (200, 404)
    res = client.delete("/api/models/does_not_exist_xyz")
    assert res.status_code == 404
    body = res.json()
    assert body["error"]["code"] == "model_not_found"
    assert body["error"]["request_id"]


def test_validation_error_is_typed(client: TestClient):
    res = client.post("/api/keys", json={"model_id": ""})
    assert res.status_code == 422
    body = res.json()
    assert body["error"]["code"] == "validation_error"


def test_openapi_docs_served(client: TestClient):
    assert client.get("/docs").status_code == 200
    spec = client.get("/openapi.json").json()
    assert spec["info"]["title"] == "ModelForge API"
    assert spec["info"]["version"] == "2.0.0"


def test_rate_limit_snapshot_endpoint(client: TestClient):
    res = client.get("/api/rate-limits")
    assert res.status_code == 200
    assert res.json()["limit_per_minute"] == 5
