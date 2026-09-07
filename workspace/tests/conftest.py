"""Shared fixtures: isolated app, real sklearn model, client helpers.

Every test gets a fully private application (own storage/state dirs, own
rate limiter) wired through the real factory — no monkey-patched globals —
plus a genuine Tfidf+NaiveBayes spam classifier, so the prediction path
exercised in CI is the exact production path.
"""

from __future__ import annotations

import joblib
import pytest
from fastapi.testclient import TestClient
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.naive_bayes import MultinomialNB
from sklearn.pipeline import Pipeline

from backend.config import Settings
from backend.main import create_app

HAM = [
    "Hello, how are you doing today?",
    "Can you send me the report by Friday?",
    "Meeting at 3pm in conference room B.",
    "Thanks for your help with the project.",
    "Please review the attached document.",
    "The files have been uploaded to the shared drive.",
    "Your order has been shipped and should arrive soon.",
    "Please confirm your availability for next week's training.",
]
SPAM = [
    "Congratulations! You won a free iPhone!",
    "Click here to claim your prize now!",
    "WIN A MILLION DOLLARS in our lottery!",
    "Urgent: your account will be closed, act now!",
    "Free cash reward waiting for you, limited offer!",
    "You are the lucky winner of our grand prize draw!",
    "Claim your exclusive reward before it expires!",
    "Limited time offer: get rich quick, click now!",
]


@pytest.fixture(scope="session")
def trained_model(tmp_path_factory):
    """Train + persist the demo spam classifier once per session."""
    model_dir = tmp_path_factory.mktemp("models")
    pipeline = Pipeline([
        ("tfidf", TfidfVectorizer(stop_words="english")),
        ("nb", MultinomialNB()),
    ])
    pipeline.fit(HAM + SPAM, [0] * len(HAM) + [1] * len(SPAM))
    pkl_path = model_dir / "spam_classifier.pkl"
    joblib.dump(pipeline, pkl_path)
    (model_dir / "spam_classifier.meta.json").write_text(
        '{"class_labels": ["HAM", "SPAM"], "feature_count": null}'
    )
    return pkl_path


@pytest.fixture()
def settings(tmp_path):
    """Isolated settings: private dirs, tiny rate limit, no demo seeding."""
    base = tmp_path / "app"
    (base / "backend" / "pkl_storage").mkdir(parents=True)
    (base / "frontend" / "static").mkdir(parents=True)
    (base / "frontend" / "js").mkdir(parents=True)
    (base / "state").mkdir(parents=True)
    return Settings(
        base_dir=base,
        storage_dir=base / "backend" / "pkl_storage",
        state_dir=base / "state",
        static_dir=base / "frontend" / "static",
        frontend_dir=base / "frontend",
        demo_models_dir=base / "demo_models",
        rate_limit_per_min=5,
        seed_demo=False,
    ).resolve()


@pytest.fixture()
def client(settings):
    """TestClient with lifespan enabled (hub started, snapshot on exit)."""
    app = create_app(settings)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def uploaded_model(client, trained_model):
    """One uploaded model + its default key: ``(model_id, api_key)``."""
    with open(trained_model, "rb") as fh:
        response = client.post(
            "/api/upload",
            files={"file": ("spam_classifier.pkl", fh, "application/octet-stream")},
            data={"name": "Spam Classifier (test)", "task_type": "classification"},
        )
    assert response.status_code == 201, response.text
    body = response.json()
    key = client.get("/api/keys", params={"model_id": body["model_id"]}).json()["keys"][0]
    return body["model_id"], key["key"]
