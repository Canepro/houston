"""Pure-logic tests (no Docker required).

Run: pip install pytest && pytest    (or: python -m pytest)
These cover version resolution (offline), preset generation, and compose
building — the parts that don't touch Docker or the network.
"""

from __future__ import annotations
from corehelpers import _SHARED_PASSWORD_OK, _live, _shared_password_readers


def test_a_bare_major_from_the_api_becomes_the_series_the_registry_publishes(monkeypatch):
    """RC 7.13.6 answers ['5','6','7','8'] where 7.12 answers ['5.0','6.0','7.0'].

    Used verbatim that produced `mongodb/mongodb-community-server:8-ubi8`, and the
    registry has no bare-major tag -- 8-ubi8 and 7-ubi8 are both 404 while 8.0-ubi8
    and 7.0-ubi8 are 200. Every `up` on those releases died with "failed to resolve
    reference ... not found".
    """
    r = _live(monkeypatch, ["5", "6", "7", "8"])
    assert r.mongo_tag == "8.0", "a bare major must become its .0 series"
    assert r.source == "releases.rocket.chat"
    assert r.mongo_flavor == "official" and r.mongo_shell == "mongosh"
    # and it says so, so the number on screen is explainable
    assert "bare major" in r.note and "8.0" in r.note


def test_an_already_dotted_answer_is_left_exactly_as_it_is(monkeypatch):
    """The common case, and it must not be rewritten: 8.2 is a real series and
    turning it into 8.0 would silently downgrade the pairing."""
    assert _live(monkeypatch, ["8.2"], version="8.0.1").mongo_tag == "8.2"
    assert _live(monkeypatch, ["5.0", "6.0", "7.0"], version="7.12.0").mongo_tag == "7.0"
    # three parts are published too, so they pass through
    assert _live(monkeypatch, ["8.0.4"], version="8.5.1").mongo_tag == "8.0.4"


def test_the_highest_compatible_version_still_wins(monkeypatch):
    """Normalising must not disturb the choice, only its spelling."""
    assert _live(monkeypatch, ["5", "8", "6"]).mongo_tag == "8.0"
    assert _live(monkeypatch, ["6.0", "5.0"], version="7.0.0").mongo_tag == "6.0"


def test_an_answer_that_parses_but_is_not_a_tag_falls_back_to_the_map(monkeypatch):
    """`8.0rc1` is a valid PEP440 version, so `_highest` accepts it happily -- and it
    is not a tag anyone publishes. Before the fix that went straight through to
    `8.0rc1-ubi8`. The curated pairing is the better answer than a tag invented from
    something the resolver cannot actually read.

    Distinct from a value like `latest`, which never reaches this guard because
    `_highest` cannot parse it as a version at all.
    """
    r = _live(monkeypatch, ["8.0rc1"], version="7.13.6")
    assert r.source == "map (fallback)"
    assert r.mongo_tag == "7.0", "the map's own answer for RC 7.x"


def test_an_api_answer_with_no_versions_falls_back_to_the_map(monkeypatch):
    """Old releases omit the field entirely."""
    assert _live(monkeypatch, [], version="7.13.6").source == "map (fallback)"


def test_sanitize_can_produce_empty_name():
    # create_repro guards this: an all-symbols name would otherwise write into
    # the repros root itself.
    from houston.services.lifecycle import sanitize
    assert sanitize("!!!") == ""


def test_version_single_source():
    import houston
    # resolved from package metadata (pyproject), never a hardcoded literal
    assert houston.__version__ and houston.__version__ != "0.0.0-dev"


# --- perf (Phase 1: timing + resource sampling) -------------------------------


def test_timings_percentiles_and_histogram():
    from houston.perf import Timings
    t = Timings()
    for v in range(1, 101):        # 1..100 ms
        t.add(float(v))
    s = t.summary()
    assert s["count"] == 100
    assert s["p50"] == 50 and s["p95"] == 95 and s["p99"] == 99
    assert s["min"] == 1 and s["max"] == 100
    assert t.rate_per_s(2.0) == 50.0
    h = t.histogram()
    assert h and h.isascii()       # ASCII sparkline (no ambiguous-width glyphs)


def test_timings_empty_is_safe():
    from houston.perf import Timings
    t = Timings()
    assert t.summary() == {"count": 0}
    assert t.pct(95) == 0.0 and t.histogram() == ""


def test_fmt_ms():
    from houston.perf.timings import fmt_ms
    assert fmt_ms(42) == "42ms" and fmt_ms(1500) == "1.50s"


def test_resource_report_windows_and_peaks():
    from houston.perf.resources import ResourceMonitor
    mon = ResourceMonitor("x")
    # inject a synthetic series: (t, cpu, mem_used, mem_limit)
    mon._series = {"rc": [(0.0, 4, 100, 2000), (1.0, 80, 500, 2000), (2.0, 30, 300, 2000)]}
    rep = mon.report()["rc"]
    assert rep.idle_cpu == 4 and rep.peak_cpu == 80 and rep.peak_cpu_t == 1.0
    assert rep.peak_mem == 500
    # windowed to just the last sample
    assert mon.report(window=(1.5, 2.5))["rc"].peak_cpu == 30


def test_mem_slopes_requires_span():
    from houston.perf.resources import ResourceMonitor
    mon = ResourceMonitor("x")
    # 20 minutes of samples, RAM growing 1MB/min -> 60MB/h
    mon._series["houston-x-rocketchat-1"] = [
        (t * 60.0, 50.0, 1e9 + t * 1e6, 8e9) for t in range(21)]
    # only 2 minutes -> too short to say anything
    mon._series["houston-x-mongodb-1"] = [(0.0, 10.0, 2e8, 8e9), (120.0, 10.0, 3e8, 8e9)]
    slopes = mon.mem_slopes()
    assert round(slopes["houston-x-rocketchat-1"] / 1e6) == 60
    assert "houston-x-mongodb-1" not in slopes


def test_loadtest_script_budgets_spike_ramps_and_parses_compound_durations():
    # No JS runtime here, so assert on the shipped script -- as the other
    # loadtest-script tests do. The invariants: the two 1s transition ramps are
    # budgeted out of --duration (3*third+2 overshot it, which also skewed
    # timeline.spike_recovery's exact-thirds windows), seconds() understands k6's
    # compound durations (1m30s), and an unrun check set reports null.
    from importlib import resources
    js = resources.files("houston").joinpath("data", "loadtest", "common.js").read_text(
        encoding="utf-8")
    assert "ms|s|m|h" in js
    assert "const body = total - 2;" in js
    assert "rate: null" in js


def test_detail_redacts_secret_env_values():
    from houston.services import lifecycle as lcsvc
    # The env tab is served to any client holding the session token and used to
    # carry these verbatim.
    for key in ("REG_TOKEN", "ADMIN_PASS",
                "OVERWRITE_SETTING_LDAP_Authentication_Password",
                "OVERWRITE_SETTING_FileUpload_S3_AWSSecretAccessKey",
                "MINIO_ROOT_PASSWORD"):
        assert lcsvc.redact_env(key, "s3cret") == lcsvc.REDACTED, key
    # non-secrets stay visible -- debugging them is the point of the tab
    for key, val in (("ROOT_URL", "http://localhost:3000"),
                     ("MONGO_URL", "mongodb://mongodb:27017/rocketchat"),
                     ("DEPLOY_METHOD", "docker")):
        assert lcsvc.redact_env(key, val) == val, key
    assert lcsvc.redact_env("REG_TOKEN", "") == ""      # empty stays empty


def test_a_credential_inside_a_url_is_redacted_even_though_the_key_is_innocent():
    """The key-name rule was not enough, and the gap opened the moment `env` started
    reading the RUNNING CONTAINER on Kubernetes.

    `MONGO_URL` matches no secret hint and, on the operator path, holds
    `mongodb://rocketchat:<real SCRAM password>@...` -- resolved out of a Secret when
    the container's environment is read. So the env tab, whose entire reason for
    masking is that a debugging aid must not hand over credentials, handed the
    database password to every member+ who opened it.

    Only the userinfo goes. The host, database, replicaSet and authSource in the rest
    of that string are what somebody is reading it FOR.
    """
    from houston.services import lifecycle as lcsvc
    url = ("mongodb://rocketchat:SuP3rS3cret@mongodb-0.mongodb-svc.houston-k.svc"
           ".cluster.local:27017/rocketchat?replicaSet=mongodb&authSource=rocketchat")
    shown = lcsvc.redact_env("MONGO_URL", url)
    assert "SuP3rS3cret" not in shown
    assert lcsvc.REDACTED in shown
    # ...and it is still a readable connection string.
    for keep in ("mongodb://", "rocketchat:", "mongodb-svc", "replicaSet=mongodb",
                 "authSource=rocketchat", ":27017"):
        assert keep in shown, keep
    # The oplog URL is the same shape and was the same leak.
    assert "SuP3rS3cret" not in lcsvc.redact_env(
        "MONGO_OPLOG_URL", "mongodb://rocketchat:SuP3rS3cret@mongodb-0:27017/local")
    # A URL with no credentials in it is left completely alone.
    plain = "mongodb://mongodb-0.mongodb:27017/rocketchat?replicaSet=rs0"
    assert lcsvc.redact_env("MONGO_URL", plain) == plain
    assert lcsvc.redact_env("ROOT_URL", "http://localhost:3000") == "http://localhost:3000"


# --- web UI static assets -----------------------------------------------------

def test_webui_hidden_toggles_actually_hide():
    """`el.hidden = true` must really hide, and must target an id that exists.

    The UA stylesheet's `[hidden] { display: none }` loses to any author rule
    setting `display` on the same element, and `form label`/`.checks label` both
    do. Without an explicit `!important` override every hidden-toggle on a label
    is a silent no-op -- the seed dialog shipped showing "Profile" and "Scale
    spec" simultaneously in both modes because of exactly this.
    """
    import re
    from importlib import resources
    webui = resources.files("houston").joinpath("data", "webui")
    css = webui.joinpath("app.css").read_text(encoding="utf-8")
    js = "\n".join(p.read_text(encoding="utf-8")
                   for p in webui.joinpath("js").iterdir()
                   if p.name.endswith(".js"))
    html = webui.joinpath("index.html").read_text(encoding="utf-8")

    assert re.search(r"\[hidden\][^{]*\{[^}]*display:\s*none\s*!important", css), \
        "app.css must force `[hidden] { display: none !important }`"

    toggled = set(re.findall(r'\$\("#([^"]+)"\)\.hidden\s*=', js))
    assert toggled, "expected the GUI modules to toggle .hidden on an element"
    missing = sorted(toggled - set(re.findall(r'id="([^"]+)"', html)))
    assert not missing, f"GUI modules toggle .hidden on id(s) not in index.html: {missing}"


def test_webui_log_service_filter_is_refreshed_by_the_stream():
    """The service dropdown must fill as log lines arrive.

    It is populated only by refreshServiceOptions(). The WebSocket handler appends
    rows straight to the DOM rather than re-rendering the list per line, so if it
    does not call that itself the dropdown stays on "all services" until something
    ELSE forces a full re-render -- changing the level, searching, toggling follow.
    That was the bug: the filter appeared empty until you touched another control.

    The call must also sit OUTSIDE the passes() check, or a service that only logs
    below the current level never becomes selectable -- exactly the service whose
    errors you are hunting when you set the filter to error+.
    """
    from importlib import resources
    js = resources.files("houston").joinpath(
        "data", "webui", "js", "logs.js").read_text(encoding="utf-8")

    assert "function refreshServiceOptions(" in js, \
        "expected the service-option builder to be callable on its own"

    # The stream no longer touches the DOM per message -- doing that meant one
    # whole-buffer rescan and one forced reflow per line, which froze the tab for
    # a second or two on a chatty container. It queues, and a frame later
    # flushLogs() does the batch. So the path is onmessage -> queueLog ->
    # flushLogs -> refreshServiceOptions, and the property is unchanged: every
    # arriving line registers its service, whether or not it is displayed.
    handler = js[js.index("ws.onmessage"):]
    handler = handler[:handler.index("ws.onclose")]
    assert "queueLog(e)" in handler, "the stream handler does not queue the line"
    assert "passes(" not in handler, \
        "the stream handler filters again — a below-threshold line must still " \
        "register its service, which is what the queue is for"

    flush = js[js.index("function flushLogs("):]
    flush = flush[:flush.index("\nfunction ")]
    assert "refreshServiceOptions()" in flush, \
        "the batched flush never refreshes the service filter"
    # Outside the per-line passes() loop, for the same reason as before.
    assert flush.index("refreshServiceOptions()") > flush.index("for (const e of batch)"), \
        "refreshServiceOptions() must see the whole batch, not one line's branch"

    # And the full re-render path keeps using it, so the two cannot drift apart.
    render = js[js.index("function renderLogList("):]
    render = render[:render.index("\n}")]
    assert "refreshServiceOptions()" in render


def test_webui_busy_state_is_styled_and_labelled():
    """Every action that shows a spinner must have a verb, and the classes app.js
    emits for it must exist in app.css.

    The busy state is assembled from three places -- the label passed to
    runAction, the BUSY_VERB lookup, and the .spin/.working CSS -- so a rename in
    any one of them silently degrades to a frozen, unstyled button.
    """
    import re
    from importlib import resources
    webui = resources.files("houston").joinpath("data", "webui")
    css = webui.joinpath("app.css").read_text(encoding="utf-8")
    js = "\n".join(p.read_text(encoding="utf-8")
                   for p in webui.joinpath("js").iterdir()
                   if p.name.endswith(".js"))

    # Keys may be bare (Stop:) or quoted ("Make default":) -- a label with a space
    # has to be quoted, and reading only bare keys made such an entry invisible
    # here, so the check passed while the button still said "Make default…".
    verbs = {bare or quoted for quoted, bare in
             re.findall(r"(?:\"([^\"]+)\"|(\w+))\s*:\s*\"\w+ing\b",
                        js[js.index("const BUSY_VERB"):].split("}")[0])}
    assert verbs, "expected a BUSY_VERB map in the GUI modules"

    # Labels handed to runAction must resolve to a verb, else the button shows the
    # bare label ("Stop…") instead of "Stopping…".
    literal = set(re.findall(r'runAction\([^,]+,\s*"([^"]+)"', js))
    state = set(re.findall(r'\b\w+:\s*"(\w+)"', js[js.index("const STATE_LABEL"):]
                           .split("}")[0]))
    missing = sorted((literal | state) - verbs)
    assert not missing, f"action label(s) with no BUSY_VERB entry: {missing}"

    for cls, sel in [("spin", r"\.spin\s*\{"), ("btn working", r"\.btn\.working"),
                     ("pill working", r"\.pill\.working")]:
        assert re.search(sel, css), f"app.js emits class {cls!r} with no rule in app.css"
    assert re.search(r"@keyframes\s+rc-spin", css), "the .spin animation is undefined"
    # A spinner that cannot animate must still say what is happening.
    assert "prefers-reduced-motion" in css


def test_two_processes_updating_config_do_not_lose_each_others_keys(tmp_path):
    """`_CONFIG_LOCK` is a `threading.Lock`, which says nothing about a second
    process — and two are the normal case: `houston serve` runs continuously while
    somebody uses the CLI on the same box. Both read config.yaml, each mutates a
    different key, both write, and the later `os.replace` silently wins.

    Atomic replacement prevents a torn FILE, never a lost UPDATE. Made deterministic
    rather than probabilistic: each child holds the read-modify-write window open for
    half a second, so without a cross-process lock the loss is certain, not likely.
    """
    import os
    import subprocess
    import sys

    import yaml

    env = {**os.environ, "HOUSTON_HOME": str(tmp_path)}
    prog = (
        "import time\n"
        "from houston import config\n"
        "def mutate(cfg):\n"
        "    time.sleep(0.5)\n"
        "    cfg[%r] = 1\n"
        "config.update_config(mutate)\n"
    )
    procs = [subprocess.Popen([sys.executable, "-c", prog % key], env=env)
             for key in ("key_from_a", "key_from_b")]
    for p in procs:
        assert p.wait(timeout=60) == 0

    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text())
    assert cfg.get("key_from_a") == 1, cfg
    assert cfg.get("key_from_b") == 1, cfg


def test_the_optional_extras_are_present_when_ci_says_they_must_be():
    """Both optional extras hide their own absence, and nothing failed when they did.

    `tests/test_web.py` `importorskip`s itself without `[gui]` and `tests/test_browser.py`
    does the same without `[browser]` + a chromium binary. That is right for a developer
    without a browser and wrong for CI, where `pytest -q` prints "808 passed, 264
    skipped" and exits 0 -- green for a GUI nobody rendered. It is the exact state that
    let a broken same-origin form POST ship while 570 HTTP tests passed, and CLAUDE.md
    and the README both warn about it in prose with no mechanical guard anywhere.

    Gated on an env var CI sets, so a developer without chromium keeps today's skips and
    the pipeline cannot silently under-install.
    """
    import os

    import pytest as _pytest

    if os.environ.get("HOUSTON_REQUIRE_EXTRAS") != "1":
        _pytest.skip("set HOUSTON_REQUIRE_EXTRAS=1 to require the extras (CI does)")

    missing = []
    try:
        import fastapi           # noqa: F401
        import multipart         # noqa: F401
    except ImportError as exc:
        missing.append(f"[gui]: {exc}")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        missing.append(f"[browser]: {exc}")
    else:
        # The PACKAGE is not the browser. Without the binary, `launch()` raises and
        # test_browser.py errors rather than skipping -- better than a skip, and still
        # not something CI should discover halfway through.
        try:
            with sync_playwright() as pw:
                pw.chromium.launch(headless=True).close()
        except Exception as exc:  # noqa: BLE001
            missing.append(f"chromium binary: {str(exc).splitlines()[0][:120]}")

    assert not missing, (
        "HOUSTON_REQUIRE_EXTRAS=1 but the suite would have skipped whole layers:\n  "
        + "\n  ".join(missing))


def test_nothing_authenticates_with_the_shared_password_by_accident():
    """A registry that is correct and is not enforced by a walk is this codebase's
    most-repeated defect, and the admin password just became one.

    Sixty-odd call sites read `config.ADMIN_PASSWORD` directly. They are now
    `meta.admin_pass`, which falls back to the same constant for a loopback
    workspace -- so the sweep is invisible in behaviour and a MISSED site is
    invisible too: it authenticates with `admin123` against a workspace whose
    password is not `admin123`, and returns a 401 that names nothing. `pat`, `api`,
    `seed`, `loadtest`, `monitor`, `upgrade` and readiness all run through those
    sites.
    """
    stray = [hit for hit in _shared_password_readers()
             if hit.rsplit(":", 1)[0] not in _SHARED_PASSWORD_OK]
    assert not stray, (
        "these read the shared loopback password directly; they want the "
        "workspace's own -- `meta.admin_pass`:\n  " + "\n  ".join(stray))


def test_the_allow_list_above_is_not_stale():
    """A file that stops using the constant must leave the list, or the list stops
    describing anything -- the same reason `PHASES` is walked rather than trusted."""
    using = {hit.rsplit(":", 1)[0] for hit in _shared_password_readers()}
    assert not (_SHARED_PASSWORD_OK - using), \
        f"allow-listed and no longer using it: {sorted(_SHARED_PASSWORD_OK - using)}"
