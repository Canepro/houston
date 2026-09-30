"""The route split (skipped unless the [gui] extra is installed).

Eighty handlers left one 2,091-line `create_app()` for twelve modules under
`web/routes/`. Nothing about that is supposed to be visible over HTTP, and the whole
risk is that something is and nobody notices:

* **A route lost, gained, or renamed.** `tests/fixtures/web_routes.json` was captured
  at `201fe8c`, the commit before the move, and is compared against whatever the
  factory builds now. Sorted, because regrouping reorders them and only one position
  actually matters.
* **The catch-all stops being last.** `spa` mounts `StaticFiles(html=True)` at `/`,
  which matches every path. One route registered after it and an API endpoint starts
  answering with `index.html` — a 200 with the wrong body, which no status-code
  assertion catches.
* **A handler reaching the wrong application.** These handlers are module-level now, so
  they reach `app` through the request rather than by closure. Getting that wrong gives
  every application in the process one shared job registry, and the suite builds dozens.
* **A module growing a second public entry point.** `register(app, ctx)` is the whole
  contract; anything else public is a second way in that `create_app()` does not call.
"""

from __future__ import annotations

import json
import pathlib

import pytest

pytest.importorskip("fastapi")

from houston.web import routes  # noqa: E402
from houston.web.app import create_app  # noqa: E402
from houston.web.routes import (_deps, backup, clusters, data,  # noqa: E402
                                edge, jobs, logs, meta, people, perf, repros,
                                session, spa)

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "web_routes.json"


def _inventory(app):
    return [{"path": getattr(r, "path", ""),
             "methods": sorted(getattr(r, "methods", None) or ["WS"]),
             "type": type(r).__name__}
            for r in app.routes]


def test_every_route_survives_the_split_unchanged():
    """The HTTP surface is the same one it was before the handlers moved."""
    want = json.loads(FIXTURE.read_text(encoding="utf-8"))
    got = _inventory(create_app())
    assert len(got) == want["count"], (
        f"{len(got)} routes now, {want['count']} before the split")
    assert sorted(got, key=lambda r: (r["path"], r["methods"], r["type"])) == want["routes"]


def test_the_static_catch_all_is_the_last_route_registered():
    """Anything after it is unreachable, and an API path would answer with index.html."""
    rows = _inventory(create_app())
    assert rows[-1] == json.loads(FIXTURE.read_text(encoding="utf-8"))["last"]
    assert rows[-1]["type"] == "Mount" and rows[-1]["path"] == ""
    mounts = [i for i, r in enumerate(rows) if r["type"] == "Mount"]
    assert mounts == [len(rows) - 1], (
        f"a Mount matches every path; these are not last: {mounts}")


def test_an_api_route_still_answers_json_and_not_the_spa():
    """The catch-all's failure mode is a 200 with the wrong body, so assert the body."""
    from fastapi.testclient import TestClient

    r = TestClient(create_app()).get("/api/health", headers={"Host": "localhost"})
    assert r.status_code == 200
    assert r.json()["ok"] is True, "an API path was served the SPA's index.html"


def test_each_route_module_declares_one_entry_point():
    for module in (meta, repros, logs, jobs, session, people, data, backup,
                   clusters, edge, perf, spa):
        assert module.__all__ == ("register",), f"{module.__name__}: {module.__all__}"
        assert callable(module.register)


def test_nothing_outside_the_package_imports_anything_but_register():
    """The checkable form of "one entry point".

    The handlers are public names -- FastAPI reports a route by its function name and
    the suite patches `open_log_process` -- so the rule cannot be spelled with an
    underscore. It is spelled here instead: an AST walk over the package and the suite,
    which is where a second way in would actually appear.
    """
    import ast

    root = pathlib.Path(__file__).resolve().parent.parent
    offenders = []
    for path in sorted((root / "houston").rglob("*.py")):
        if path.parent.name == "routes":
            continue                      # siblings may reach each other
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.ImportFrom):
                continue
            mod = node.module or ""
            if not mod.startswith("houston.web.routes."):
                continue
            for alias in node.names:
                if alias.name != "register":
                    offenders.append(f"{path.relative_to(root)}: {mod}.{alias.name}")
    assert not offenders, ("these reach into a route module for something other than "
                           f"register(): {offenders}")


def test_the_registration_order_names_only_modules_that_exist():
    from importlib import import_module

    for name in routes.REGISTRATION_ORDER:
        module = import_module(f"houston.web.routes.{name}")
        assert callable(module.register), name
    assert len(set(routes.REGISTRATION_ORDER)) == len(routes.REGISTRATION_ORDER)


def test_handlers_reach_their_own_application_not_a_shared_one():
    """`_deps` resolves through the request, so two apps keep two job registries."""
    a, b = create_app(), create_app()

    class _Carrier:
        def __init__(self, app):
            self.app = app

    assert _deps.jobs(_Carrier(a)) is a.state.jobs
    assert _deps.jobs(_Carrier(b)) is b.state.jobs
    assert _deps.jobs(_Carrier(a)) is not _deps.jobs(_Carrier(b))
    assert _deps.ctx(_Carrier(a)) is a.state.ctx


def test_a_job_submitted_through_a_route_lands_in_that_apps_registry():
    """The end-to-end form of the check above: a job started by a handler must be
    visible to the same application's /api/jobs, not to some other one's."""
    from fastapi.testclient import TestClient

    from houston.services import lifecycle as lc
    from houston.services import users as usersvc

    other = create_app()
    app = create_app()
    usersvc.add("alice", "correct-horse-battery", role="admin")
    c = TestClient(app, base_url="http://localhost")
    assert c.post("/signin", data={"user": "alice", "password": "correct-horse-battery"},
                  follow_redirects=False, headers={"Host": "localhost"}).status_code == 303

    lc.resolve_name  # noqa: B018 - named so a rename of the seam shows up here
    r = c.post("/api/repros/nope/ready", headers={"Host": "localhost"})
    assert r.status_code in (200, 404, 409), r.text
    if r.status_code == 200:
        assert app.state.jobs.list_jobs(), "the job went somewhere else"
        assert not other.state.jobs.list_jobs(), "two applications share one registry"
