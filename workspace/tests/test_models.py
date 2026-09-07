"""Model lifecycle: upload validation, listing, deletion, events."""

from __future__ import annotations

import joblib
from fastapi.testclient import TestClient
from sklearn.naive_bayes import MultinomialNB


def test_upload_valid_model(client: TestClient, trained_model):
    with open(trained_model, "rb") as fh:
        res = client.post(
            "/api/upload",
            files={"file": ("spam_classifier.pkl", fh, "application/octet-stream")},
            data={"name": "My Spam Model", "description": "test model", "task_type": "unknown"},
        )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["task_type"] == "classification"
    assert body["class_labels"] == ["HAM", "SPAM"]
    assert "Default API key" in body["message"]

    listing = client.get("/api/models").json()
    assert listing["count"] == 1
    assert listing["models"][0]["name"] == "My Spam Model"
    assert listing["models"][0]["request_count"] == 0


def test_upload_rejects_non_pkl_extension(client: TestClient):
    res = client.post(
        "/api/upload",
        files={"file": ("evil.txt", b"not a model", "text/plain")},
        data={"name": "bad"},
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "unsupported_file_type"


def test_upload_rejects_invalid_pkl_content(client: TestClient):
    res = client.post(
        "/api/upload",
        files={"file": ("fake.pkl", b"this is not a pickled model", "application/octet-stream")},
        data={"name": "fake"},
    )
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "invalid_model_file"
    # catalog must stay empty — the rejected artifact is cleaned up
    assert client.get("/api/models").json()["count"] == 0


def test_upload_rejects_object_without_predict(tmp_path, client: TestClient):
    pkl = tmp_path / "no_predict.pkl"
    joblib.dump({"not": "an estimator"}, pkl)
    with open(pkl, "rb") as fh:
        res = client.post(
            "/api/upload",
            files={"file": ("no_predict.pkl", fh, "application/octet-stream")},
            data={"name": "dict"},
        )
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "invalid_model_file"


def test_upload_rejects_empty_file(client: TestClient):
    res = client.post(
        "/api/upload",
        files={"file": ("empty.pkl", b"", "application/octet-stream")},
        data={"name": "empty"},
    )
    assert res.status_code == 422


def test_upload_is_atomic_on_validation_failure(client: TestClient, settings):
    before = sorted(p.name for p in settings.storage_dir.iterdir())
    client.post(
        "/api/upload",
        files={"file": ("junk.pkl", b"garbage bytes", "application/octet-stream")},
        data={"name": "junk"},
    )
    after = sorted(p.name for p in settings.storage_dir.iterdir())
    assert before == after  # no .tmp leftovers, no partial artifacts


def test_delete_model_cascades(client: TestClient, uploaded_model):
    model_id, _ = uploaded_model
    assert client.get("/api/models").json()["count"] == 1

    res = client.delete(f"/api/models/{model_id}")
    assert res.status_code == 200
    assert res.json()["deleted_keys"] >= 1

    assert client.get("/api/models").json()["count"] == 0
    assert client.get("/api/keys", params={"model_id": model_id}).json()["count"] == 0


def test_delete_missing_model_is_typed_404(client: TestClient):
    res = client.delete("/api/models/nope")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "model_not_found"


def test_numeric_model_predict_roundtrip(tmp_path, client: TestClient):
    """A regression-shaped model exercises the 2D numeric input path."""
    pkl = tmp_path / "reg.pkl"
    joblib.dump(MultinomialNB().fit([[1, 0], [0, 1], [2, 1], [1, 2]], [0, 1, 0, 1]), pkl)
    with open(pkl, "rb") as fh:
        up = client.post(
            "/api/upload",
            files={"file": ("reg.pkl", fh, "application/octet-stream")},
            data={"name": "regressor-ish"},
        ).json()
    assert up["task_type"] in ("classification", "unknown")
