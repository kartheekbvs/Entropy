"""Prediction endpoint: auth, adaptation, telemetry, rate limit, logs."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_predict_spam_text(client: TestClient, uploaded_model):
    model_id, key = uploaded_model
    res = client.post(
        f"/api/predict/{model_id}",
        headers={"X-API-Key": key},
        json={"data": ["Congratulations! You won a free prize, click now!"]},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["model_name"]
    assert body["task_type"] == "classification"
    assert body["class_labels"] == ["HAM", "SPAM"]
    assert 0 <= body["latency_ms"] < 5000
    # raw_output for a 1-sample text prediction is [label_index]
    assert body["raw_output"] in ([0], [1], 0, 1)


def test_predict_ham_text(client: TestClient, uploaded_model):
    model_id, key = uploaded_model
    res = client.post(
        f"/api/predict/{model_id}",
        headers={"X-API-Key": key},
        json={"data": ["Hi, please review the attached report by Friday."]},
    )
    assert res.status_code == 200
    assert res.json()["raw_output"] in ([0], [1], 0, 1)


def test_predict_batch_text(client: TestClient, uploaded_model):
    model_id, key = uploaded_model
    res = client.post(
        f"/api/predict/{model_id}",
        headers={"X-API-Key": key},
        json={"data": ["Hello friend", "FREE MONEY CLICK HERE"]},
    )
    assert res.status_code == 200
    assert isinstance(res.json()["raw_output"], list) and len(res.json()["raw_output"]) == 2


def test_predict_requires_key_header(client: TestClient, uploaded_model):
    model_id, _ = uploaded_model
    res = client.post(f"/api/predict/{model_id}", json={"data": ["hi"]})
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "authentication_required"


def test_predict_rejects_malformed_key(client: TestClient, uploaded_model):
    model_id, _ = uploaded_model
    res = client.post(
        f"/api/predict/{model_id}",
        headers={"X-API-Key": "not-a-valid-key"},
        json={"data": ["hi"]},
    )
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "authentication_required"


def test_predict_rejects_unknown_key(client: TestClient, uploaded_model):
    model_id, _ = uploaded_model
    res = client.post(
        f"/api/predict/{model_id}",
        headers={"X-API-Key": "mf_" + "0" * 32},
        json={"data": ["hi"]},
    )
    assert res.status_code == 401


def test_predict_rejects_key_for_other_model(client: TestClient, uploaded_model):
    model_id, key = uploaded_model
    res = client.post(
        f"/api/predict/{model_id}other",
        headers={"X-API-Key": key},
        json={"data": ["hi"]},
    )
    assert res.status_code in (403, 404)
    if res.status_code == 403:
        assert res.json()["error"]["code"] == "forbidden"


def test_prediction_is_logged(client: TestClient, uploaded_model):
    model_id, key = uploaded_model
    client.post(
        f"/api/predict/{model_id}",
        headers={"X-API-Key": key},
        json={"data": ["Meeting at noon"]},
    )
    logs = client.get(f"/api/logs/{model_id}").json()
    assert logs["count"] >= 1
    entry = logs["logs"][-1]
    assert entry["success"] is True
    assert entry["latency_ms"] >= 0
    assert "Meeting" in entry["input_data"]


def test_rate_limit_returns_429_with_retry_after(client: TestClient, uploaded_model):
    """settings fixture sets the limit to 5/min; hammer past it."""
    model_id, key = uploaded_model
    statuses = []
    last = None
    for _ in range(8):
        last = client.post(
            f"/api/predict/{model_id}",
            headers={"X-API-Key": key},
            json={"data": ["ping"]},
        )
        statuses.append(last.status_code)
        if last.status_code == 429:
            break
    assert 429 in statuses
    assert last is not None and last.status_code == 429
    assert last.json()["error"]["code"] == "rate_limit_exceeded"
    assert int(last.headers["Retry-After"]) >= 1


def test_empty_data_rejected(client: TestClient, uploaded_model):
    model_id, key = uploaded_model
    res = client.post(
        f"/api/predict/{model_id}",
        headers={"X-API-Key": key},
        json={"data": []},
    )
    assert res.status_code == 422


def test_logs_for_missing_model(client: TestClient):
    assert client.get("/api/logs/ghost").status_code == 404
