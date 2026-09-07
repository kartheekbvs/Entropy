"""Thread-safe model catalog with atomic JSON snapshot persistence.

The catalog keeps models, API keys and prediction logs in memory protected by a
single re-entrant lock (the service is single-process by design; scale-out
means one process per replica, which the Dockerfile/compose setup documents).
Two production behaviours are layered on top of the plain dict of v1:

* **Persistence** — the full catalog is snapshotted to ``state/catalog.json``
  after every mutating call (atomic tmp+rename, debounced). On boot the
  snapshot is replayed, so a restart never loses uploaded models or keys.
* **Key index** — ``mf_`` secrets are additionally indexed in a dict for O(1)
  authentication lookups instead of the v1 linear scan.

All timestamps are ISO-8601 UTC. Every public method is thread-safe.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, TypeVar

logger = logging.getLogger("modelforge.store")

T = TypeVar("T")
_SAFE_ID = re.compile(r"[^a-z0-9_-]+")
LATENCY_WINDOW = 200


def utcnow_iso() -> str:
    """Current UTC time as an ISO-8601 string with timezone suffix."""
    return datetime.now(timezone.utc).isoformat()


def sanitize_stem(filename: str) -> str:
    """Reduce an arbitrary filename to a URL/model-id-safe slug."""
    stem = Path(filename).stem.lower().replace(" ", "_")
    return _SAFE_ID.sub("", stem)[:60] or "model"


@dataclass
class ApiKey:
    id: str
    key: str
    key_hash: str
    model_id: str
    purpose: str
    label: str
    created_at: str
    request_count: int = 0
    is_active: bool = True


@dataclass
class PredictionLog:
    id: str
    model_id: str
    api_key_id: str
    input_data: str
    output_data: str
    prediction: str
    latency_ms: float
    timestamp: str
    success: bool
    error_message: str = ""


@dataclass
class Model:
    id: str
    name: str
    filename: str
    pkl_path: str
    description: str
    task_type: str
    uploaded_at: str
    size_bytes: int = 0
    request_count: int = 0
    feature_count: int | None = None
    class_labels: list[str] | None = None
    _recent_latencies: list[float] = field(default_factory=list, repr=False)

    def to_public(self) -> dict[str, Any]:
        """Serializable view served by the API (drops private bookkeeping)."""
        avg = (
            round(sum(self._recent_latencies) / len(self._recent_latencies), 2)
            if self._recent_latencies
            else None
        )
        return {
            "id": self.id,
            "name": self.name,
            "task_type": self.task_type,
            "description": self.description,
            "uploaded_at": self.uploaded_at,
            "size_bytes": self.size_bytes,
            "request_count": self.request_count,
            "class_labels": self.class_labels,
            "feature_count": self.feature_count,
            "latency_avg_ms": avg,
        }


class Storage:
    """In-memory catalog + snapshot persistence (see module docstring)."""

    SNAPSHOT = "catalog.json"

    def __init__(self, state_dir: Path, history_limit: int = 5000) -> None:
        self._lock = threading.RLock()
        self._models: dict[str, Model] = {}
        self._api_keys: dict[str, ApiKey] = {}
        self._key_index: dict[str, str] = {}  # secret -> key id
        self._logs: list[PredictionLog] = []
        self._history_limit = history_limit
        self._state_dir = Path(state_dir)
        self._snapshot_path = self._state_dir / self.SNAPSHOT
        self._mutated = False
        self._load()

    # ── lifecycle ────────────────────────────────────────────────────────

    def _load(self) -> None:
        """Replay the last snapshot if present. Missing/corrupt file = fresh state."""
        if not self._snapshot_path.exists():
            return
        try:
            raw = json.loads(self._snapshot_path.read_text(encoding="utf-8"))
            for m in raw.get("models", []):
                lat = m.pop("_recent_latencies", [])
                model = Model(**{k: v for k, v in m.items() if k in Model.__dataclass_fields__})
                model._recent_latencies = [float(x) for x in lat][-LATENCY_WINDOW:]
                self._models[model.id] = model
            for k in raw.get("api_keys", []):
                key = ApiKey(**{kk: vv for kk, vv in k.items() if kk in ApiKey.__dataclass_fields__})
                self._api_keys[key.id] = key
                self._key_index[key.key] = key.id
            for lg in raw.get("logs", [])[-self._history_limit:]:
                self._logs.append(PredictionLog(**{kk: vv for kk, vv in lg.items() if kk in PredictionLog.__dataclass_fields__}))
            logger.info(
                "catalog_restored models=%d keys=%d logs=%d", len(self._models), len(self._api_keys), len(self._logs)
            )
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            logger.warning("snapshot_corrupt path=%s err=%s — starting fresh", self._snapshot_path, exc)

    def persist(self) -> None:
        """Atomically write the snapshot (tmp file + ``os.replace``)."""
        with self._lock:
            payload = {
                "version": 2,
                "saved_at": utcnow_iso(),
                "models": [{**asdict(m), "_recent_latencies": m._recent_latencies[-LATENCY_WINDOW:]} for m in self._models.values()],
                "api_keys": [asdict(k) for k in self._api_keys.values()],
                "logs": [asdict(l) for l in self._logs[-self._history_limit:]],
            }
        self._state_dir.mkdir(parents=True, exist_ok=True)
        tmp = self._snapshot_path.with_suffix(".json.tmp")
        try:
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self._snapshot_path)
        except OSError as exc:  # pragma: no cover - disk failure path
            logger.error("snapshot_write_failed err=%s", exc)

    def maybe_persist(self) -> None:
        """Persist only when mutations happened since the last flush."""
        with self._lock:
            if not self._mutated:
                return
            self._mutated = False
        self.persist()

    # ── models ───────────────────────────────────────────────────────────

    def add_model(self, model: Model) -> Model:
        with self._lock:
            self._models[model.id] = model
            self._mutated = True
        return model

    def get_model(self, model_id: str) -> Model | None:
        with self._lock:
            return self._models.get(model_id)

    def list_models(self) -> list[Model]:
        with self._lock:
            return list(self._models.values())

    def update_model_meta(
        self, model_id: str, *, task_type: str | None = None,
        class_labels: list[str] | None = None, feature_count: int | None = None,
    ) -> None:
        with self._lock:
            m = self._models.get(model_id)
            if not m:
                return
            if task_type is not None:
                m.task_type = task_type
            if class_labels is not None:
                m.class_labels = class_labels
            if feature_count is not None:
                m.feature_count = feature_count
            self._mutated = True

    def delete_model(self, model_id: str) -> tuple[bool, int]:
        """Delete a model and its keys; returns ``(deleted, deleted_key_count)``."""
        with self._lock:
            if model_id not in self._models:
                return False, 0
            del self._models[model_id]
            doomed = [k for k, v in self._api_keys.items() if v.model_id == model_id]
            for k in doomed:
                del self._api_keys[k]
            self._key_index = {v.key: kid for kid, v in self._api_keys.items()}
            self._logs = [l for l in self._logs if l.model_id != model_id]
            self._mutated = True
            return True, len(doomed)

    def record_latency(self, model_id: str, latency_ms: float) -> None:
        with self._lock:
            m = self._models.get(model_id)
            if m:
                m.request_count += 1
                m._recent_latencies.append(latency_ms)
                m._recent_latencies = m._recent_latencies[-LATENCY_WINDOW:]
                self._mutated = True

    # ── api keys ─────────────────────────────────────────────────────────

    def register_key(self, key: ApiKey) -> ApiKey:
        with self._lock:
            self._api_keys[key.id] = key
            self._key_index[key.key] = key.id
            self._mutated = True
        return key

    def find_key_by_secret(self, secret: str) -> ApiKey | None:
        with self._lock:
            key_id = self._key_index.get(secret)
            return self._api_keys.get(key_id) if key_id else None

    def list_keys(self, model_id: str) -> list[ApiKey]:
        with self._lock:
            return [k for k in self._api_keys.values() if k.model_id == model_id]

    def revoke_key(self, key_id: str) -> ApiKey | None:
        with self._lock:
            k = self._api_keys.get(key_id)
            if not k:
                return None
            k.is_active = False
            self._mutated = True
            return k

    def record_key_request(self, key_id: str) -> None:
        with self._lock:
            k = self._api_keys.get(key_id)
            if k:
                k.request_count += 1

    # ── logs ─────────────────────────────────────────────────────────────

    def add_log(self, log: PredictionLog) -> PredictionLog:
        with self._lock:
            log.id = uuid.uuid4().hex[:10]
            self._logs.append(log)
            if len(self._logs) > self._history_limit:
                self._logs = self._logs[-self._history_limit:]
            self._mutated = True
        return log

    def get_logs(self, model_id: str, limit: int = 100) -> list[PredictionLog]:
        with self._lock:
            rows = [l for l in self._logs if l.model_id == model_id]
            return rows[-limit:]

    # ── stats ────────────────────────────────────────────────────────────

    def stats(self, connected_clients: int = 0) -> dict[str, Any]:
        with self._lock:
            total_requests = sum(m.request_count for m in self._models.values())
            latencies = [x for m in self._models.values() for x in m._recent_latencies]
            return {
                "total_models": len(self._models),
                "total_api_keys": len(self._api_keys),
                "active_api_keys": sum(1 for k in self._api_keys.values() if k.is_active),
                "total_requests": total_requests,
                "avg_latency_ms": round(sum(latencies) / len(latencies), 2) if latencies else None,
                "connected_clients": connected_clients,
                "models": [m.to_public() for m in self._models.values()],
                "recent_logs": [asdict(l) for l in self._logs[-50:]],
            }


def new_model_id(filename: str) -> str:
    """Collision-safe model id: ``model_<epoch_ms>_<uuid8>_<slug>``."""
    return f"model_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}_{sanitize_stem(filename)}"
