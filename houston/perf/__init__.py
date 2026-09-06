"""Performance tooling for houston (Phase 1: timing + resource sampling).

  - `timings.Timings`  — latency distribution (p50/p90/p95/p99 + a sparkline)
  - `resources.ResourceMonitor` — background docker-stats sampler (CPU/RAM peaks)
These power the `seed` timing breakdown, the `--stats` resource cost, and the
`houston stats` command. Later phases (loadtest / benchmark / capacity) build on
the same primitives.
"""

from houston.perf.resources import ResourceMonitor
from houston.perf.timings import Timings

__all__ = ["Timings", "ResourceMonitor"]
