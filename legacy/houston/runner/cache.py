"""cache -- see the package docstring."""
from __future__ import annotations

import threading
import time


#: Read-only docker QUERIES that the dashboard poll repeats. Each open tab asks
#: for /api/repros every 4s, which is `docker compose ls` + `docker ps` + `docker
#: info`; ten teammates with a tab open is ~40 process spawns every 4 seconds on
#: the shared box. Memoised just long enough to collapse concurrent tabs into one
#: call, and INVALIDATED by every mutation so the UI never shows a stale state
#: after an action -- a cache the user can notice would be worse than the spawns.
_QUERY_TTL = 2.5

_query_cache: dict[str, tuple[float, object]] = {}

_query_lock = threading.Lock()

def invalidate_docker_queries() -> None:
    """Drop memoised docker state. Called after anything that changes it."""
    with _query_lock:
        _query_cache.clear()
    global _docker_seen
    _docker_seen = None

def _cached_query(key: str, fn):
    now = time.monotonic()
    with _query_lock:
        hit = _query_cache.get(key)
        if hit is not None and now - hit[0] < _QUERY_TTL:
            return hit[1]
    value = fn()
    with _query_lock:
        _query_cache[key] = (now, value)
    return value
