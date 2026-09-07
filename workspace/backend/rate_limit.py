"""Per-key sliding-window rate limiter.

A fixed 60-second sliding window per API key, tracked in memory with the
request timestamp deque. The limiter is deliberately lock-light (one coarse
mutex over the whole table — correctness first, and the workload is
single-process by design). ``0`` or a negative configured limit disables the
limiter entirely.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from typing import Callable, TypeVar

T = TypeVar("T")
WINDOW_S = 60.0


class RateLimiter:
    """Sliding-window limiter keyed by API key id."""

    def __init__(self, limit_per_minute: int) -> None:
        self._limit = limit_per_minute
        self._lock = threading.Lock()
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    @property
    def limit(self) -> int:
        return self._limit

    @property
    def enabled(self) -> bool:
        return self._limit > 0

    def check(self, key_id: str) -> tuple[bool, int]:
        """Try to consume one slot. Returns ``(allowed, retry_after_seconds)``."""
        if not self.enabled:
            return True, 0
        now = time.monotonic()
        with self._lock:
            window = self._hits[key_id]
            cutoff = now - WINDOW_S
            while window and window[0] < cutoff:
                window.popleft()
            if len(window) >= self._limit:
                retry_after = int(WINDOW_S - (now - window[0])) + 1
                return False, max(retry_after, 1)
            window.append(now)
            return True, 0

    def reset(self, key_id: str | None = None) -> None:
        """Clear limits for one key or all keys (admin/tests)."""
        with self._lock:
            if key_id is None:
                self._hits.clear()
            else:
                self._hits.pop(key_id, None)

    def snapshot(self) -> dict[str, int]:
        """Current per-key usage in the active window (observability)."""
        now = time.monotonic()
        with self._lock:
            return {
                kid: sum(1 for t in hits if t > now - WINDOW_S)
                for kid, hits in self._hits.items()
                if any(t > now - WINDOW_S for t in hits)
            }


def enforce_rate_limit(limiter: RateLimiter, key_id: str, on_exceeded: Callable[[int], T]) -> T | None:
    """Call ``on_exceeded(retry_after_s)`` when the key is out of budget.

    Returns ``None`` when allowed so callers can branch without exceptions::

        if enforce_rate_limit(limiter, kid, raise_limited):
            return  # handled
    """
    allowed, retry_after = limiter.check(key_id)
    if not allowed:
        return on_exceeded(retry_after)
    return None
