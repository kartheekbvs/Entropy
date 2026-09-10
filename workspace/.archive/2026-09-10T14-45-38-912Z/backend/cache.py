"""Bounded LRU cache of loaded predictors.

Loading a joblib artifact costs CPU + memory; inference should never pay that
price twice. This cache keeps at most ``capacity`` warm predictors and evicts
the least-recently-used one under a re-entrant lock, so a many-model host
stays within a predictable memory budget (default 8 warm models).
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Callable

from backend.predictor import ModelPredictor, ModelValidationError


class PredictorCache:
    """Thread-safe LRU of :class:`ModelPredictor` keyed by model id."""

    def __init__(self, capacity: int = 8) -> None:
        if capacity < 1:
            raise ValueError("capacity must be >= 1")
        self._capacity = capacity
        self._lock = threading.RLock()
        self._entries: OrderedDict[str, ModelPredictor] = OrderedDict()

    @property
    def capacity(self) -> int:
        return self._capacity

    def size(self) -> int:
        with self._lock:
            return len(self._entries)

    def get(self, model_id: str) -> ModelPredictor | None:
        with self._lock:
            predictor = self._entries.get(model_id)
            if predictor is not None:
                self._entries.move_to_end(model_id)
            return predictor

    def put(self, model_id: str, predictor: ModelPredictor) -> None:
        with self._lock:
            self._entries[model_id] = predictor
            self._entries.move_to_end(model_id)
            while len(self._entries) > self._capacity:
                evicted_id, _ = self._entries.popitem(last=False)
                self._on_evict(evicted_id)

    def discard(self, model_id: str) -> None:
        with self._lock:
            self._entries.pop(model_id, None)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    # hooks ───────────────────────────────────────────────────────────────

    _on_evict: Callable[[str], None] = lambda model_id: None  # noqa: E731

    def set_eviction_listener(self, listener: Callable[[str], None]) -> None:
        """Optional callback invoked (lock held) when a model is evicted."""
        self._on_evict = listener


def cached_predictor(
    cache: PredictorCache,
    model_id: str,
    loader: Callable[[], ModelPredictor],
) -> ModelPredictor:
    """Get-or-load helper. ``loader`` may raise :class:`ModelValidationError`."""
    predictor = cache.get(model_id)
    if predictor is not None:
        return predictor
    predictor = loader()
    cache.put(model_id, predictor)
    return predictor
