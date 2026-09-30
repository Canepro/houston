"""paths -- see the package docstring."""
from __future__ import annotations

import re
from pathlib import Path
from houston import config


#: `<home>/edge` -- deliberately a sibling of `repros/`, never inside it.
EDGE_DIR = "edge"

#: Traefik watches this for one routing file per registered name.
DYNAMIC_DIR = "dynamic"

#: The Edge spec as written, so a later process can rebuild it exactly.
SPEC_FILE = "spec.json"

#: The compose project name. The underscore is load-bearing: `sanitize()` maps
#: every non `[a-z0-9-]` character to "-", so no repro can ever be named
#: `houston_edge`, and the edge's project therefore cannot collide with a repro
#: literally named "edge" -- which WOULD collide under `PROJECT_PREFIX + name`,
#: and would let `down` on that repro tear down the box's only ingress.
PROJECT = "houston_edge"

#: The edge's own container, as compose names it: <project>-<service>-<index>.
CONTAINER = f"{PROJECT}-edge-1"

def edge_dir() -> Path:
    return config.home() / EDGE_DIR

def dynamic_dir() -> Path:
    return edge_dir() / DYNAMIC_DIR

def compose_path() -> Path:
    return edge_dir() / "compose.yml"

def route_path(name: str) -> Path:
    return dynamic_dir() / f"{name}.yml"

def certs_dir() -> Path:
    return edge_dir() / "certs"

#: `<address>:<port>`, the only shape a Traefik TCP server takes. Checked rather
#: than trusted: a bare address here loads as a router with no reachable server, so
#: the name answers nothing and Traefik says so only in its own log.
_ADDR_RE = re.compile(r"^[A-Za-z0-9._\[\]:-]+:\d{1,5}$")

#: The host a generated route matches, whichever kind it is. `Host()` for an HTTP
#: router, `HostSNI()` for a TCP passthrough.
_RULE_HOST = re.compile(r"Host(?:SNI)?\(`([^`]+)`\)")

#: Where a unit file goes. Printed, never written -- see systemd_unit().
UNIT_PATH = "/etc/systemd/system/houston.service"
