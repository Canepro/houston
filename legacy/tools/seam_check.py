#!/usr/bin/env python
"""The three invariants whose breach is fatal rather than merely untidy.

    .venv/bin/python tools/seam_check.py
    .venv/bin/python tools/seam_check.py --explain
    .venv/bin/python tools/seam_check.py --json

`CLAUDE.md` states these in prose and nothing has ever checked them. Each is maintained
by convention today, and each has a specific failure that is not a style complaint:

* **Only one module may spawn a process.** Forty subprocess call sites with no single
  funnel was forty places to get quoting, timeouts and error typing subtly different.
  `houston/exec.py` is now the L0 funnel; a direct subprocess import or launch anywhere
  else is a violation.

  It is **forty**, and `CLAUDE.md` and `RULES.md` both say forty-five. Three defensible
  counts of one thing: 45 textual occurrences of `subprocess.run|Popen|...`, 42
  `subprocess.X` attribute accesses, and 40 actual CALLS. The extras are a type
  annotation (`k8s.py:6596`, `proc: subprocess.Popen`) and prose in a docstring
  (`edge.py:930`). Only a call can spawn anything, so 40 was the entry count. The final
  gate is stricter still: a direct subprocess import outside `exec.py` is itself a
  breach, before it grows a call. `FINDINGS.md` §4 records the same measurement lesson
  for code lines and step 0.7 for cyclomatic complexity.
* **`services/`, `perf/` and `presets/` may not import `ui`.** `ui.die()` raises
  `typer.Exit`. That is correct in a one-shot CLI process and **fatal inside `serve`**,
  where one bad request would exit the whole server and take every other user's session
  with it. This rule has zero violations today, so it is a live gate rather than a
  ratchet -- the first breach fails the build.
* **Only a seam may open a socket to a workspace.** `rcapi.py` is documented as "the only
  RC REST seam", and it owns auth, 2FA, retry and error typing. A direct `requests` call
  elsewhere gets all four subtly different, and the ways it differs only show up against
  a real Rocket.Chat.

**It detects CALLS, not imports, and that distinction found two false positives.**
`web/app.py` imports `requests` solely to catch `requests.RequestException` and routes
the actual call through `rcapi.call()` -- its docstring even explains why that is not an
open proxy. An import-based rule would have flagged the one module that is doing it
right. `web/app.py` also imports `urllib.parse.quote`, which is a parser and never opens
anything. So the check is on the call site.

`socket.getaddrinfo` is likewise separated out: resolving a name is not connecting to it.
`services/lifecycle.py` does exactly that and is not a violation.

**Every violation prints its reason, not just its path.** A gate that fires in six months
and says only `services/foo.py:412` teaches nobody why it exists, and the next person
routes around it. This repo's tests are written the same way.
"""
from __future__ import annotations

import argparse
import ast
import json
import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
PACKAGE = "houston"

# --- Rule 1: process spawning ------------------------------------------------------
#
# Allowed module -> (sites today, why). The three sites are the subprocess import and
# the two deliberately transparent run/Popen calls in the one process boundary.
SPAWN_TARGET = f"{PACKAGE}/exec.py"
SPAWN_ALLOWED: dict[str, tuple[int, str]] = {
    "houston/exec.py": (3, "the sole process boundary: one import and two launch calls"),
}
SPAWN_CALLS = {"run", "Popen", "call", "check_output", "check_call"}
SPAWN_APIS = ({f"subprocess.{name}" for name in SPAWN_CALLS}
              | {"os.system", "os.popen", "asyncio.create_subprocess_exec",
                 "asyncio.create_subprocess_shell"})
SPAWN_WHY = (
    "only one module may import subprocess or launch a process. Scattered calls get "
    "quoting, timeouts and error typing subtly different; the sole boundary is "
    f"{SPAWN_TARGET}")

# --- Rule 2: ui must not reach the service layer -----------------------------------
UI_MODULE = f"{PACKAGE}.ui"
UI_FORBIDDEN_UNDER = ("houston/services/", "houston/perf/", "houston/presets/")
UI_WHY = (
    "services/, perf/ and presets/ must not import ui: ui.die() raises typer.Exit, "
    "which is correct in a one-shot CLI process and FATAL inside `serve` -- one bad "
    "request would exit the whole server. Raise a ReproError instead; the CLI renders "
    "it and the web layer maps it to an HTTP status")

# --- Rule 3: only a seam may dial a workspace --------------------------------------
#
# Allowed module -> (call sites today, why it is allowed). The four seams plus the TLS
# seam, plus two modules that reach an EXTERNAL service rather than a workspace. The
# three entries marked BYPASS are real deviations from "rcapi is the only RC REST seam",
# recorded so the number cannot grow while they wait to be fixed.
NETWORK_ALLOWED: dict[str, tuple[int, str]] = {
    "houston/rcapi.py": (26, "THE Rocket.Chat REST seam -- auth, 2FA, retry, error typing"),
    "houston/runner/ports.py": (2, "binds a socket to find a free host port. A BIND "
                                  "test, not a dial: it never speaks to a workspace, "
                                  "which is what this rule is about"),
    # The Kubernetes seam, mid-split into `services/k8s/`. Both sockets are accounted
    # for by the module that will own them when the split reaches them:
    # `is_local_address` -> `endpoints`, `forward_reachable` -> `forward`. Keyed on the
    # remainder while it exists, the way `doctor` was during phase 2a.
    "houston/services/k8s/forward.py": (1, "the Kubernetes seam: `forward_reachable` "
                                          "confirms a port-forward has actually BOUND "
                                          "its socket. `kubectl port-forward` returns a "
                                          "pid before it binds, so the pid is not the "
                                          "answer -- and after `restart`, `ready` exited "
                                          "0 on the strength of one while the very next "
                                          "request got nothing"),
    "houston/services/k8s/endpoints.py": (1, "the Kubernetes seam: `is_local_address` "
                                             "asks whether an ingress address is THIS "
                                             "box by trying to bind it. A bind test, "
                                             "not a dial -- it never speaks to a "
                                             "workspace, which is what the rule is "
                                             "about"),
    "houston/tls.py": (2, "the TLS seam: a raw handshake to read back a certificate, "
                          "with the domain as SNI. rcapi speaks REST and cannot do this"),
    "houston/versions.py": (1, "GETs releases.rocket.chat for the RC->MongoDB pairing. "
                               "An external endpoint, not a workspace"),
    # `houston/services/doctor.py` until phase 2a made it a package; the version-lookup
    # check is its own module now and the allowance is keyed on the file.
    # Moved by step 2b.15: the seeding half to `seed/apply.py`, the readback half to
    # `seed/check.py`. Still a BYPASS in both, still recorded and not endorsed -- the
    # split does not make it right, it only says where it is.
    "houston/seed/apply.py": (2, "BYPASS: calls /api/v1/channels.info and groups.info "
                                 "directly instead of through rcapi"),
    "houston/seed/check.py": (1, "BYPASS: `readback` opens its own session to read the "
                                 "rooms back, rather than going through rcapi"),
    "houston/services/doctor/checks/versions.py": (1, "GETs releases.rocket.chat as a "
                                                      "reachability preflight. External, "
                                                      "not a workspace"),
    "houston/services/perf.py": (1, "BYPASS: POSTs /api/v1/login directly instead of "
                                    "through rcapi. Recorded, not endorsed"),
    # `houston/cli.py` until phase 2a made the CLI a package, then
    # `houston/cli/__init__.py` until `_login_seed_users` reached its own module. The
    # allowance is keyed on the FILE, so each split moved the site out from under it and
    # the gate failed -- loudly both times, which is the behaviour wanted.
    "houston/cli/_perf_render.py": (1, "BYPASS: `_login_seed_users` POSTs /api/v1/login "
                                       "directly from the CLI layer so a load test has "
                                       "real identities behind it. Recorded, not "
                                       "endorsed"),
}
CONNECT_CALLS = {
    ("requests", "get"), ("requests", "post"), ("requests", "put"), ("requests", "delete"),
    ("requests", "patch"), ("requests", "head"), ("requests", "request"),
    ("requests", "Session"), ("socket", "socket"), ("socket", "create_connection"),
    ("http.client", "HTTPConnection"), ("http.client", "HTTPSConnection"),
    ("websockets", "connect"),
}
# Resolving a name is not connecting to it. `services/lifecycle.py` calls getaddrinfo to
# check what a hostname points at, which opens nothing.
RESOLVE_ONLY = {("socket", "getaddrinfo"), ("socket", "gethostbyname")}
NETWORK_WHY = (
    "only a seam may open a socket to a workspace. rcapi.py is the only RC REST seam "
    "and owns auth, 2FA, retry and error typing; a direct requests call gets all four "
    "subtly different, and the difference only shows up against a real Rocket.Chat")

RULES = {
    "spawns_a_process": SPAWN_WHY,
    "service_layer_imports_ui": UI_WHY,
    "dials_outside_a_seam": NETWORK_WHY,
}


def _dotted(node: ast.Attribute) -> str | None:
    """`socket.socket` and `http.client.HTTPConnection`, as a dotted string."""
    parts: list[str] = [node.attr]
    current: ast.AST = node.value
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if not isinstance(current, ast.Name):
        return None
    parts.append(current.id)
    return ".".join(reversed(parts))


def _split(dotted: str) -> tuple[str, str]:
    module, _, attribute = dotted.rpartition(".")
    return module, attribute


def scan(path: pathlib.Path) -> dict[str, list[tuple[int, str]]]:
    """Every site in one module that any of the three rules cares about."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    hits: dict[str, list[tuple[int, str]]] = {rule: [] for rule in RULES}

    # Resolve the ordinary alias forms before inspecting calls. A gate that catches
    # `subprocess.run()` but misses `import subprocess as sp; sp.run()` is a spelling
    # convention, not a boundary. Imported callables need the same treatment.
    module_aliases: dict[str, str] = {}
    callable_aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                module_aliases[alias.asname or alias.name.split(".")[0]] = alias.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                local = alias.asname or alias.name
                target = f"{node.module}.{alias.name}"
                callable_aliases[local] = target
                module_aliases[local] = target

    def called_name(node: ast.Call) -> str | None:
        if isinstance(node.func, ast.Name):
            return callable_aliases.get(node.func.id)
        if not isinstance(node.func, ast.Attribute):
            return None
        dotted = _dotted(node.func)
        if not dotted:
            return None
        root, dot, rest = dotted.partition(".")
        return f"{module_aliases.get(root, root)}{dot}{rest}"

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(alias.name == "subprocess" for alias in node.names):
                hits["spawns_a_process"].append((node.lineno, "subprocess import"))
            for alias in node.names:
                if alias.name == UI_MODULE:
                    hits["service_layer_imports_ui"].append((node.lineno, alias.name))
        elif isinstance(node, ast.ImportFrom):
            if node.module == "subprocess":
                hits["spawns_a_process"].append((node.lineno, "subprocess import"))
            base = node.module or ""
            if base == UI_MODULE:
                hits["service_layer_imports_ui"].append((node.lineno, base))
            elif base == PACKAGE:
                for alias in node.names:
                    if alias.name == "ui":
                        hits["service_layer_imports_ui"].append(
                            (node.lineno, f"{PACKAGE}.ui"))
        elif isinstance(node, ast.Call):
            dotted = called_name(node)
            if not dotted:
                continue
            module, attribute = _split(dotted)
            if dotted in SPAWN_APIS:
                hits["spawns_a_process"].append((node.lineno, dotted))
            elif (module, attribute) in CONNECT_CALLS:
                hits["dials_outside_a_seam"].append((node.lineno, dotted))
            elif (module, attribute) in RESOLVE_ONLY:
                continue
    return hits


def check() -> tuple[list[dict], dict[str, int]]:
    violations: list[dict] = []
    totals = {rule: 0 for rule in RULES}

    for path in sorted((REPO_ROOT / PACKAGE).rglob("*.py")):
        rel = str(path.relative_to(REPO_ROOT))
        hits = scan(path)

        for rule, allowed in (("spawns_a_process", SPAWN_ALLOWED),
                              ("dials_outside_a_seam", NETWORK_ALLOWED)):
            sites = hits[rule]
            totals[rule] += len(sites)
            if not sites:
                continue
            budget, reason = allowed.get(rel, (0, ""))
            if len(sites) <= budget:
                continue
            # Sorted by line, so when a module exceeds its budget the site reported is
            # the LAST one -- most likely the line just added, rather than whichever the
            # AST walk happened to reach first.
            for lineno, what in sorted(sites)[budget:]:
                violations.append({
                    "rule": rule, "where": f"{rel}:{lineno}", "what": what,
                    "reason": RULES[rule],
                    "detail": (f"{rel} is allowed {budget} and has {len(sites)}"
                               if budget else f"{rel} is not allowed to at all")
                    + (f". Allowed because: {reason}" if reason else ""),
                })

        sites = hits["service_layer_imports_ui"]
        totals["service_layer_imports_ui"] += len(sites)
        if sites and rel.startswith(UI_FORBIDDEN_UNDER):
            for lineno, what in sites:
                violations.append({
                    "rule": "service_layer_imports_ui", "where": f"{rel}:{lineno}",
                    "what": what, "reason": RULES["service_layer_imports_ui"],
                    "detail": "no budget for this: the rule has zero violations today, "
                              "so this is the first",
                })

    return violations, totals


def explain() -> str:
    out = ["The three invariants, why each one is fatal, and who is exempt.", ""]
    out.append(f"1. spawns_a_process -- {SPAWN_WHY}")
    out.append(f"   Target after Phase 1: only {SPAWN_TARGET}.")
    for module, (count, reason) in sorted(SPAWN_ALLOWED.items(),
                                          key=lambda kv: (-kv[1][0], kv[0])):
        out.append(f"     {count:>3} site{'' if count == 1 else 's'}  {module}"
                   f"\n              {reason}")
    out += ["", f"2. service_layer_imports_ui -- {UI_WHY}"]
    out.append(f"   Applies to: {', '.join(UI_FORBIDDEN_UNDER)}")
    out.append("   Exempt: nobody. Zero violations today, so the first one fails the build.")
    out.append("   Two modules DO import `ui` and both are permitted, being outside those "
               "directories: `jsonout.py` at 3 sites -- it is what puts `ui` into stderr "
               "mode so --json owns stdout -- and `cli/` at 1, which is the front end "
               "`ui` exists for.")
    out += ["", f"3. dials_outside_a_seam -- {NETWORK_WHY}"]
    out.append("   Detected on the CALL, not the import: `web/app.py` imports `requests` "
               "only to catch RequestException and dials through rcapi.call(), and "
               "`socket.getaddrinfo` resolves without connecting.")
    for module, (count, reason) in sorted(NETWORK_ALLOWED.items(),
                                          key=lambda kv: (-kv[1][0], kv[0])):
        out.append(f"     {count:>3} site{'' if count == 1 else 's'}  {module}"
                   f"\n              {reason}")
    return "\n".join(out)


def render(violations: list[dict], totals: dict[str, int]) -> str:
    out = [f"{sum(totals.values())} sites checked across {len(RULES)} rules: "
           + ", ".join(f"{rule}={count}" for rule, count in totals.items())]
    if not violations:
        out += ["", "  no seam is breached. Run with --explain for what is allowed and why."]
        return "\n".join(out)
    for rule in RULES:
        hits = [v for v in violations if v["rule"] == rule]
        if not hits:
            continue
        out += ["", f"  {rule}: {len(hits)}", f"      WHY: {RULES[rule]}"]
        for v in hits:
            out.append(f"      {v['where']}  {v['what']}\n          {v['detail']}")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--explain", action="store_true",
                    help="print each rule, its reason, and every exemption with its "
                         "justification; check nothing")
    ap.add_argument("--json", action="store_true", help="machine-readable violations")
    args = ap.parse_args()

    if args.explain:
        print(explain())
        return 0

    try:
        violations, totals = check()
    except SyntaxError as exc:
        print(f"tools/seam_check.py: {exc.filename}:{exc.lineno} will not parse: {exc.msg}",
              file=sys.stderr)
        return 2

    if args.json:
        json.dump({"violations": violations, "totals": totals}, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print(render(violations, totals))

    if violations:
        print(f"\n{len(violations)} seam breach(es). Each line above says why the rule "
              f"exists; --explain lists every exemption and its justification.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
