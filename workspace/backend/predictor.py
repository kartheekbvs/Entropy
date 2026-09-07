"""Safe joblib model loading and prediction.

Unpickling is a privileged operation: ModelForge accepts ``.pkl`` files only
from the operator of the instance (self-hosted, single-tenant) and loads each
artifact exactly once into a process. The predictor then adapts arbitrary
input shapes so callers can send a flat list, a batch, numeric rows or plain
strings (TfidfVectorizer pipelines), and always receives JSON-serializable
output.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import joblib
import numpy as np

logger = logging.getLogger("modelforge.predictor")

TASK_TYPES = ("classification", "regression", "clustering", "unknown")


class ModelValidationError(Exception):
    """The artifact exists but cannot be used for inference."""


class ModelPredictor:
    """Wraps one loaded estimator with metadata + input adaptation."""

    def __init__(self, pkl_path: str | Path, task_type: str = "unknown") -> None:
        self.pkl_path = str(pkl_path)
        self.task_type = task_type if task_type in TASK_TYPES else "unknown"
        self._model: Any = None
        self._class_labels: list[str] | None = None
        self._feature_count: int | None = None
        self._loaded_at: float = 0.0

    # ── loading ──────────────────────────────────────────────────────────

    def load(self, *, validate: bool = True) -> "ModelPredictor":
        """Load the artifact, validate it predicts, and extract metadata.

        Args:
            validate: run a smoke ``__repr__``/attribute probe (cheap) and
                re-raise problems as :class:`ModelValidationError`.

        Raises:
            ModelValidationError: unpickling failed or the object has no
                ``predict`` callable.
        """
        import time

        try:
            self._model = joblib.load(self.pkl_path)
        except Exception as exc:  # noqa: BLE001 - unpickle failures are diverse
            raise ModelValidationError(f"Could not deserialize model: {exc}") from exc

        if not callable(getattr(self._model, "predict", None)):
            raise ModelValidationError("Artifact has no callable predict() — not a scikit-learn style estimator")

        self._read_sidecar_metadata()
        if self.task_type == "unknown":
            self.task_type = self._detect_task_type()
        self._loaded_at = time.time()
        logger.info("model_loaded path=%s task=%s", Path(self.pkl_path).name, self.task_type)
        if validate:
            self._validate_metadata()
        return self

    def _read_sidecar_metadata(self) -> None:
        meta_path = Path(self.pkl_path).with_suffix(".meta.json")
        if not meta_path.exists():
            return
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            self._class_labels = meta.get("class_labels")
            self._feature_count = meta.get("feature_count")
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("sidecar_meta_unreadable path=%s err=%s", meta_path.name, exc)

    def _validate_metadata(self) -> None:
        if self._class_labels is None and hasattr(self._model, "classes_"):
            try:
                self._class_labels = [str(c) for c in self._model.classes_]
            except Exception:  # noqa: BLE001
                pass
        if self._feature_count is None:
            n = getattr(self._model, "n_features_in_", None)
            if isinstance(n, (int, np.integer)) and n > 0:
                self._feature_count = int(n)

    # ── task detection ─────────────────────────────────────────────────

    @staticmethod
    def _unwrap_estimator(model: Any, max_depth: int = 6) -> Any:
        """Peel sklearn wrappers (Pipeline, stacking, voting) to the core estimator.

        Pipelines do not mirror ``classes_`` or ``_estimator_type`` of their
        final step, so detection inspects the estimator that actually
        predicts. Bounded depth guards against pathological nesting.
        """
        for _ in range(max_depth):
            steps = getattr(model, "steps", None)  # Pipeline
            if isinstance(steps, list) and steps and isinstance(steps[-1], (tuple, list)) and len(steps[-1]) == 2:
                model = steps[-1][1]
                continue
            final = getattr(model, "final_estimator", None)  # stacking ensembles
            if final is not None:
                model = final
                continue
            estimators = getattr(model, "estimators_", None)  # voting ensembles
            if isinstance(estimators, list) and estimators:
                model = estimators[-1]
                continue
            break
        return model

    def _detect_task_type(self) -> str:
        """Best-effort task classification from the estimator's own surface.

        Precedence: scikit-learn's authoritative ``_estimator_type`` →
        class-name convention → attribute probes. Never raises — an
        undetectable artifact simply reports ``"unknown"``.
        """
        candidates = [self._model, self._unwrap_estimator(self._model)]
        for est in candidates:
            etype = getattr(est, "_estimator_type", None)
            if etype == "classifier":
                return "classification"
            if etype == "regressor":
                return "regression"
            if etype == "clusterer":
                return "clustering"
        for est in candidates:
            name = type(est).__name__.lower()
            if "classifier" in name:
                return "classification"
            if "regressor" in name:
                return "regression"
            if "cluster" in name:
                return "clustering"
        for est in candidates:
            if hasattr(est, "classes_"):
                return "classification"
            if hasattr(est, "n_clusters") or hasattr(est, "labels_"):
                return "clustering"
            if callable(getattr(est, "predict_proba", None)) and callable(getattr(est, "predict", None)):
                return "classification"
        return "unknown"

    # ── metadata ─────────────────────────────────────────────────────────

    @property
    def class_labels(self) -> list[str] | None:
        return self._class_labels

    @property
    def feature_count(self) -> int | None:
        return self._feature_count

    @property
    def loaded_at(self) -> float:
        return self._loaded_at

    # ── prediction ───────────────────────────────────────────────────────

    def predict(self, data: Any) -> dict[str, Any]:
        """Run inference. Returns a JSON-serializable result envelope.

        Never raises for model-level input problems — the envelope carries
        ``success=False`` and a sanitized error message so the router can log
        the failure and answer with a typed 422.
        """
        if self._model is None:
            return {"success": False, "error": "Model is not loaded", "task_type": self.task_type}

        try:
            X = self._adapt_input(data)
            result = self._model.predict(X)
            formatted = self._format_output(result)
            return {
                "success": True,
                "prediction": formatted["prediction"],
                "raw_output": formatted["raw"],
                "task_type": self.task_type,
                "class_labels": self._class_labels,
            }
        except Exception as exc:  # noqa: BLE001 - surfaced as typed 422 upstream
            logger.warning(
                "prediction_failed path=%s err=%s", Path(self.pkl_path).name, exc
            )
            return {
                "success": False,
                "error": str(exc)[:500],
                "task_type": self.task_type,
            }

    def _adapt_input(self, data: Any) -> Any:
        """Coerce caller JSON into what sklearn pipelines expect."""
        if not isinstance(data, list):
            return data
        if len(data) == 0:
            raise ValueError("data must not be empty")
        if isinstance(data[0], list):
            return np.asarray(data, dtype=float)
        if isinstance(data[0], str):
            return data  # text pipeline (e.g. TfidfVectorizer)
        arr = np.asarray(data, dtype=float)
        return arr.reshape(1, -1) if arr.ndim == 1 else arr

    def _format_output(self, result: Any) -> dict[str, Any]:
        """Convert numpy/primitive prediction output to JSON-safe values."""
        raw: Any
        prediction: Any

        if isinstance(result, np.ndarray):
            raw = result.tolist()
            if result.ndim == 0:
                prediction = result.item()
            elif result.ndim == 1:
                if self._class_labels and len(self._class_labels) == len(result):
                    prediction = [
                        {"label": str(self._class_labels[i]), "score": float(v)}
                        for i, v in enumerate(result)
                    ]
                else:
                    prediction = raw[0] if len(raw) == 1 else raw
            else:
                prediction = raw
        elif isinstance(result, (list, tuple)):
            raw = list(result)
            prediction = raw[0] if len(raw) == 1 else raw
        else:
            raw = result
            prediction = result

        if self._class_labels and isinstance(prediction, (int, np.integer)):
            idx = int(prediction)
            if 0 <= idx < len(self._class_labels):
                prediction = str(self._class_labels[idx])
        elif isinstance(prediction, np.generic):
            prediction = prediction.item()
        return {"prediction": prediction, "raw": raw}


def load_predictor_safely(pkl_path: str | Path, task_type: str = "unknown") -> ModelPredictor:
    """Load + validate, translating failures into :class:`ModelValidationError`."""
    return ModelPredictor(pkl_path, task_type).load(validate=True)


__all__ = ["ModelPredictor", "ModelValidationError", "load_predictor_safely", "TASK_TYPES"]
