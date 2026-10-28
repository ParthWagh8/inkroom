"""Small in-process rate limiter.

The API is deliberately single-worker (see README): limits are per process and
reset on restart. Put a shared limiter at the edge if you run more than one.
"""
from __future__ import annotations

import threading
import time
from collections import deque


class SlidingWindowLimiter:
    def __init__(self, per_minute: int, per_hour: int, per_day: int) -> None:
        self.per_minute = max(0, per_minute)
        self.per_hour = max(0, per_hour)
        self.per_day = max(0, per_day)
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _count(hits: deque[float], since: float) -> int:
        count = 0
        for stamp in reversed(hits):
            if stamp < since:
                break
            count += 1
        return count

    def hit(self, key: str) -> tuple[bool, int]:
        """Record one request. Returns (allowed, retry_after_seconds)."""
        if self.per_minute <= 0 and self.per_hour <= 0 and self.per_day <= 0:
            return True, 0

        now = time.monotonic()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            cutoff = now - 86_400
            while hits and hits[0] < cutoff:
                hits.popleft()

            checks = (
                (self.per_minute, 60, "minute"),
                (self.per_hour, 3_600, "hour"),
                (self.per_day, 86_400, "day"),
            )
            for limit, window, _ in checks:
                if limit <= 0:
                    continue
                used = self._count(hits, now - window)
                if used >= limit:
                    oldest = hits[-limit] if len(hits) >= limit else now
                    retry = max(1, int(oldest + window - now) + 1)
                    return False, retry

            hits.append(now)
            return True, 0
