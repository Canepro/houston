"""`houston.cli`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import source_index
from conftest import source_of
from houston.services import edge as fd
from houston.services import lifecycle as lc
from servicehelpers import _k8s_meta, _quoted_houston_commands


def test_a_done_warning_reaches_the_terminal_and_a_done_info_does_not(capsys):
    """`_cli_emit` suppressed EVERY event at `phase="done"`, at every level.

    The suppression is right for the informational ones -- the command wrapper prints
    the final panel and would say it twice. It was wrong for warnings, and six of them
    are raised at exactly that phase, because `done` is where a service says what it
    finished doing. So a CLI user was never told that an orphaned namespace could not be
    removed, that a workspace was skipped by `prune`, that the cluster was left alone,
    that a monitoring volume was left behind, or -- the sharpest -- that `stop` on an
    operator-managed workspace frees Rocket.Chat's memory and not MongoDB's, which is a
    warning written specifically so `stop` would say it instead of staying quiet.
    """
    from houston import cli
    from houston.services.events import Event

    # The full 3x2 matrix, so this cannot pass by accident on one level.
    for level in ("info", "warn", "error"):
        for phase in ("done", "teardown"):
            capsys.readouterr()
            cli._cli_emit(Event(f"{level}-{phase}", phase=phase, level=level))
            out = capsys.readouterr()
            printed = f"{level}-{phase}" in (out.out + out.err)
            want = not (phase == "done" and level == "info")
            assert printed is want, (
                f"level={level} phase={phase}: printed={printed}, expected {want}")

    # A terminal event stays suppressed whatever its level -- that half was never the bug.
    capsys.readouterr()
    cli._cli_emit(Event("terminal-warn", phase="teardown", level="warn", terminal=True))
    out = capsys.readouterr()
    assert "terminal-warn" not in (out.out + out.err)


def test_loadtest_target_detection():
    from houston import cli
    assert cli._loadtest_target({"services": {"rocketchat": {}, "mongodb": {}}}) == "http://rocketchat:3000"
    assert cli._loadtest_target({"services": {"traefik": {}, "rocketchat-1": {}}}) == "http://traefik:80"
    assert cli._loadtest_target({"services": {"rocketchat-1": {}, "rocketchat-2": {}}}) == "http://rocketchat-1:3000"


def test_parse_endpoint():
    from houston import cli
    assert cli._parse_endpoint("GET /api/v1/channels.list") == ("GET", "/api/v1/channels.list")
    assert cli._parse_endpoint("post /api/v1/chat.postMessage") == ("POST", "/api/v1/chat.postMessage")
    assert cli._parse_endpoint("/api/v1/me") == ("GET", "/api/v1/me")   # bare path defaults to GET
    assert cli._parse_endpoint("GET /api/v1/x?count=100&a=b")[1] == "/api/v1/x?count=100&a=b"
    for bad in ("", "GET channels.list", "  "):   # empty / non-absolute path
        try:
            cli._parse_endpoint(bad)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for {bad!r}")


def test_parse_endpoint_unsupported_method():
    from houston import cli
    assert cli._parse_endpoint("PATCH /api/v1/x") == ("PATCH", "/api/v1/x")
    try:
        cli._parse_endpoint("HEAD /api/v1/me")
    except ValueError as exc:
        assert "unsupported method" in str(exc)
    else:
        raise AssertionError("expected ValueError for HEAD")


def test_parse_ramp():
    from houston import cli
    assert cli._parse_ramp("10:200") == (10, 200)
    for bad in ("10", "a:b", "5:0", "1:2:3"):
        try:
            cli._parse_ramp(bad)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for ramp {bad!r}")


def test_short_res_map_keeps_multi_instance_index():
    # Multi-instance rocketchat-1/-2 must not collapse to one key (report data loss).
    from houston import cli
    res = {"houston-x-rocketchat-1": 1, "houston-x-rocketchat-2": 2, "houston-x-mongodb-1": 3}
    assert sorted(cli._short_res_map(res, "x")) == ["mongodb", "rocketchat-1", "rocketchat-2"]
    # Single instance still collapses to the clean base name.
    single = {"houston-y-rocketchat-1": 1, "houston-y-mongodb-1": 2}
    assert sorted(cli._short_res_map(single, "y")) == ["mongodb", "rocketchat"]


def test_the_tls_verdict_stops_waiting_when_no_challenge_can_reach_the_host(
        tmp_path, monkeypatch):
    """It waited twenty seconds for a certificate that could not arrive.

    With a cluster holding :80 and :443, neither HTTP-01 nor TLS-ALPN can complete --
    the challenge request is answered by the cluster. Polling anyway printed "waiting
    for the certificate…" and then a message saying issuance "may still complete",
    which is how a reader learns to ignore the line that mattered.
    """
    from houston import cli
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.endpoints, "port_claiming_cluster",
                        lambda *a, **k: k8s.PortClaim(
                            context="default", service="kube-system/traefik",
                            address="172.31.46.139", ports=[80, 443]))
    slept = []
    monkeypatch.setattr("time.sleep", lambda s: slept.append(s))
    said = []
    monkeypatch.setattr(cli.ui, "warn", lambda m, *a, **k: said.append(m))
    monkeypatch.setattr(cli.ui, "note", lambda m, *a, **k: said.append(m))
    monkeypatch.setattr(cli.ui, "hint", lambda m, *a, **k: said.append(m))
    monkeypatch.setattr(cli.ui, "ok", lambda m, *a, **k: said.append(m))

    cli._report_gui_tls("gui.example.test", tries=10, pause=2.0)

    assert not slept, "nothing to wait for — a cluster is answering the challenge"
    joined = "\n".join(said)
    assert "cannot get a certificate" in joined, joined
    assert "may still complete" not in joined, "that is false here"
    assert "172.31.46.139" in joined, joined


def test_config_get_and_list_tell_false_apart_from_unset(tmp_path, monkeypatch):
    """`cfg.get(k) or '(unset)'` renders a stored `False` as unset, and
    `acme.staging` is a BOOLEAN whose whole history is people not being able to tell
    which way it is set.

    `config set acme.staging false` reported success and then both `get` and `list`
    said the key was unset -- the same confusion, one layer up, as the `bool("false")`
    defect this key already had.
    """
    from typer.testing import CliRunner

    from houston import cli

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    run = CliRunner()

    assert run.invoke(cli.app, ["config", "set", "acme.staging", "false"]).exit_code == 0
    got = run.invoke(cli.app, ["config", "get", "acme.staging"])
    assert got.output.strip() == "False", f"a stored False printed as {got.output!r}"
    listed = run.invoke(cli.app, ["config", "list"]).output
    assert "(unset)" not in [ln for ln in listed.splitlines()
                             if "acme.staging" in ln][0], listed

    # And a key that really is unset still says so.
    assert run.invoke(cli.app, ["config", "unset", "acme.staging"]).exit_code == 0
    assert run.invoke(cli.app, ["config", "get", "acme.staging"]).output.strip() == ""
    listed = run.invoke(cli.app, ["config", "list"]).output
    assert "(unset)" in [ln for ln in listed.splitlines()
                         if "acme.staging" in ln][0], listed


def test_every_command_this_tool_tells_you_to_run_actually_exists():
    """A message naming a command that does not exist is worse than no message: it
    reads as authoritative and costs the reader a round trip to find out otherwise.

    This is not hypothetical. The migration and the doctor check both said `houston
    edge up`, and the verb is `start` -- so the one instruction printed at somebody
    whose edge had just stopped was the one thing they could not run. Nothing else in
    the suite could have caught it: the string was correct English in a correct
    sentence, and no test executes the text of a warning.
    """
    from houston import cli

    known = {c.name or c.callback.__name__ for c in cli.app.registered_commands}
    known |= {g.name for g in cli.app.registered_groups}
    wrong = sorted({(verb, where) for verb, where in _quoted_houston_commands()
                    if verb not in known})
    assert not wrong, (
        "these messages name a `houston <verb>` that is not a registered command: "
        + ", ".join(f"`houston {v}` in {w}" for v, w in wrong))


def test_every_edge_action_this_tool_tells_you_to_run_actually_exists():
    """The same rule one level down, where it actually bit.

    `edge` dispatches on a positional action rather than sub-commands, so a wrong verb
    is not a Typer error at import -- it is a runtime "unknown action" in front of
    somebody following instructions. The valid set is read from the CLI's own help
    text so this cannot drift from it.
    """
    import pathlib
    import re

    import houston
    from houston import cli

    # The FUNCTION, found by name, wherever it lives: `cli.edge` never existed (the
    # command is `edge_cmd`), so this silently fell back to reading a whole file.
    src = source_of(cli.edge_cmd)
    declared = re.search(r'help="((?:status|start)[^"]*)"', src)
    assert declared, "could not find the edge action list in the CLI to check against"
    valid = {w.strip() for w in declared.group(1).split("|")}
    assert "start" in valid and "status" in valid, valid

    root = pathlib.Path(houston.__file__).parent
    wrong = []
    for path in sorted(root.rglob("*.py")):
        for m in re.finditer(r"`houston edge ([a-z-]+)",
                             path.read_text(encoding="utf-8")):
            if m.group(1) not in valid:
                wrong.append(f"`houston edge {m.group(1)}` in {path.name}")
    assert not wrong, ("these messages name an edge action that does not exist: "
                       + ", ".join(sorted(set(wrong))) + f". Valid: {sorted(valid)}")


def test_a_command_in_the_notes_is_never_wrapped_where_it_would_be_pasted(capsys):
    """`_print_notes` wrapped every line to the box it drew, commands included. A
    port-forward came out as `... port-forward deployment/rocketchat-` on one line and
    `  rocketchat 3000:3000` on the next, so the one thing anyone does with that line
    -- select it and paste it -- produced a broken command. The box is gone and an
    indented line overflows the width instead.

    Driven from a RECORDED flat note, which is both what an older workspace holds and
    the shape the derived groups render commands in.
    """
    from houston import cli

    forward = ("kubectl -n houston-a-fairly-long-workspace-name port-forward "
               "deployment/rocketchat-rocketchat 3000:3000")
    assert len(forward) > 88          # wider than anything `_print_notes` renders
    m = lc.runner.Metadata(
        name="c", project="houston-c", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="default",
        root_url="http://localhost:3000", host_port=3000, version_source="map",
        extra={"notes": ["bring the forward back with:", "    " + forward,
                         "`stats` needs metrics-server in the cluster " * 3]})
    cli._print_notes(m)
    out = capsys.readouterr().out.split("\n")
    assert [ln for ln in out if forward in ln], "the command has to survive as one line"
    assert not any(ln.rstrip().endswith("rocketchat-") for ln in out)
    # Prose is still wrapped, and a hyphenated word is not broken across the wrap.
    assert not any(ln.rstrip().endswith("metrics-") for ln in out)
    prose = [ln for ln in out if ln[:5] == "    " + ln[4:5].strip()]
    assert prose and max(len(ln) for ln in prose) <= 88


def test_the_terminal_prints_the_same_sections_the_panel_draws(capsys):
    """One definition, two renderings. The CLI used to print a flat list inside a box
    while the browser drew cards, and the two could only be compared by eye.
    """
    from houston import cli

    m = _k8s_meta()
    cli._print_notes(m)
    out = capsys.readouterr().out
    for group in lc.note_groups_of(m):
        # `_ascii` first: the terminal renderer replaces the middle dot in a step
        # heading, because a box-drawing or typographic glyph is not width-1 everywhere.
        title = cli._ascii(group["title"])
        assert any(ln.strip() == title for ln in out.split("\n")), title
        for k, v in group["rows"]:
            assert any(k in ln and str(v) in ln for ln in out.split("\n")), k
        for c in group["commands"]:
            assert c in out


def test_an_unproven_seed_does_not_pass_verify_seed(monkeypatch, tmp_path):
    """`--verify-seed` gated on `faults`, which is [] when the readback COULD NOT RUN.

    `check_seed` returns `{"ok": None, "faults": [], ...}` when it cannot read the
    workspace back -- a login failure, a 429, a workspace that stopped answering. So
    the flag whose entire job is to refuse an unverified seed exited 0 on a seed it had
    verified nothing about, and `_print_seed_verification` returned before printing
    anything, making it indistinguishable from a seed nobody asked to verify.

    The shipped agent skill states the rule the other way round and in bold: "Treat a
    false or missing `verification.ok` as unproven -- do not infer success from a 2xx
    write or an attempted message count."
    """

    from houston import cli

    src = source_of(cli._run_seed)
    # The unknown is gated BEFORE the faults check, and on `ok`, not on `faults`.
    assert 'verify and verdict.get("ok") is None' in src, (
        "--verify-seed still passes a readback that could not run")
    assert source_index(src, 'verdict.get("ok") is None') < source_index(src, 'verdict.get("faults")'), (
        "the unknown case must be judged before the fault list")
    assert "UNPROVEN" in src

    # And the renderer says something rather than nothing.
    rsrc = source_of(cli._print_seed_verification)
    assert "could not run" in rsrc, "an unrunnable readback still prints nothing"
    assert 'if not verdict or verdict.get("ok") is None:\n        return' not in rsrc

    # AND THE REASON REACHES THE USER. This first asserted that `check_seed` is passed
    # an `emit`, which pinned the mechanism rather than the property -- and the
    # mechanism was then correctly removed, because the service emits the same facts
    # the CLI renders and every line printed twice. The reason travels in the verdict
    # as `why` now, so what matters is that the renderer shows it.
    assert 'verdict.get("why")' in rsrc, (
        "the reason a readback could not run is not shown to anybody")
    from houston.services import lifecycle as lc
    csrc = source_of(lc.check_seed)
    assert '"why": str(exc)' in csrc, "check_seed does not record why it could not read back"


def test_the_eks_guide_ships_and_its_commands_are_real():
    """A procedure people copy, kept where the tool is rather than where the repo is.

    Two ways this rots. It can fail to ship -- package-data is a glob somebody has to
    remember to widen, and without it the file is in the repository, every test passes,
    and it is simply absent from an installed houston, which is the one place it
    matters. And it can drift from the CLI: a walkthrough is only useful if every
    command in it still exists, and nothing else would notice a renamed one.
    """
    import re
    from pathlib import Path

    from houston import cli
    from houston.services import eks

    body = eks.guide()
    assert eks.guide_path() is not None
    assert len(body.splitlines()) > 100, "the guide is a walkthrough, not a stub"

    text = Path(eks.__file__).parents[2].joinpath("pyproject.toml").read_text()
    assert "data/docs/*.md" in text, \
        "the guide would not ship: pyproject package-data has no data/docs/*.md glob"

    # Every `houston <command>` the guide tells somebody to RUN has to be one --
    # scanned from code only. The prose says "houston built this cluster" and
    # "houston never reaches it", and a scan of the whole text reads those as
    # commands named `built` and `never`.
    known = {c.name or (c.callback and c.callback.__name__) for c in cli.app.registered_commands}
    known |= {g.name for g in getattr(cli.app, "registered_groups", [])}
    known.discard(None)
    code = "\n".join(re.findall(r'```[a-z]*\n(.*?)```', body, re.S))
    code += "\n" + "\n".join(re.findall(r'`([^`\n]+)`', body))
    used = set(re.findall(r'\bhouston ([a-z][a-z-]*)', code))
    unknown = sorted(used - known)
    # AND THE ACTION AFTER IT. `houston cluster prepair` passes the check above --
    # `cluster` is a real command -- so a renamed action would sail through the very
    # test written to stop the guide rotting. Measured: it did.
    actions = set(re.findall(r'\bhouston cluster ([a-z][a-z-]*)', code))
    unknown += sorted(actions - set(cli.CLUSTER_ACTIONS) - {"--path", "--json"})
    assert not unknown, (
        f"the guide names commands that do not exist: {unknown}. "
        f"houston has: {sorted(known)}")


def test_no_hint_tells_somebody_to_pass_a_runtime_a_context_already_implies():
    """These are the lines people copy out of the terminal.

    `cluster create` finished by printing `houston up --runtime kubernetes --context
    arn:aws:eks:us-east-1:533674205877:cluster/rc-final --version 8.5.1` -- the two
    most awkward forms of the command at once, from the one place a first-timer is
    most likely to copy. `--context` has implied Kubernetes since `infer_runtime`
    landed, and a cluster's own name has been enough since short names did. A hint
    that teaches otherwise is not merely verbose; it is the tool contradicting itself.
    """
    from pathlib import Path

    from houston import cli

    # The whole CLI package: `cluster create`'s hint left `__init__.py` in phase 2a.
    text = "\n".join(p.read_text(encoding="utf-8")
                     for p in sorted(Path(cli.__file__).parent.rglob("*.py")))
    offenders = [line.strip() for line in text.splitlines()
                 if "--runtime kubernetes" in line and "--context" in line]
    assert not offenders, (
        "a printed hint passes --runtime kubernetes beside --context, which already "
        f"implies it: {offenders}")

    # And the create hint names the cluster rather than pasting its ARN back. The
    # hint is an f-string split over two source lines, so the window is the lines
    # around it rather than one quoted run.
    lines = text.splitlines()
    at = next((i for i, ln in enumerate(lines) if "point a workspace at it" in ln), -1)
    assert at >= 0, "the create hint moved — check it still teaches the short form"
    window = " ".join(lines[at:at + 2])
    assert "--runtime" not in window
    assert "{name}" in window, \
        "it must name the cluster the way the person just named it, not by its ARN"


def test_tls_status_probes_the_name_when_tls_terminates_in_the_cluster(monkeypatch):
    """`tls-status` dials 127.0.0.1 with the domain as SNI so a proxy in front cannot
    answer for us. That is right for a workspace THIS box terminates TLS for, and
    wrong for every Kubernetes one: the certificate is a Secret in the cluster, the
    cluster's own ingress holds :443, and the create says so in as many words — "this
    machine is not in the path".

    MEASURED against a live EKS workspace: `openssl s_client` and `curl` both fetched
    a real Let's Encrypt certificate for the name from this very box, `curl` reported
    `ssl_verify_result: 0`, and `tls-status` answered "the ingress controller's
    built-in placeholder certificate ... the ACME order is stuck". Loopback had reached
    houston's OWN edge, a Traefik that has never heard of the name. A healthy
    workspace reported as broken is the exact failure this command exists to prevent.

    `tls_terminates` is recorded on the workspace by `_create_kubernetes`, so the
    answer is already there — it just was not asked.
    """
    import ast
    import inspect

    from conftest import source_of, source_of_route
    from houston import cli as climod

    # The GUI half is found through the ROUTE, not through a filename. This used to read
    # `houston/web/app.py`; phase 2a moved the handler into `houston/web/routes/repros.py`
    # and it failed loudly -- the good outcome, but the next move would do it again.
    # Asking the router which function answers `/tls` cannot go stale.
    # The CLI half is the MODULE that defines `tls-status`, not a named file: the
    # loopback probe lives in a sibling helper, and the module follows the command
    # wherever it moves. The GUI half is found through the router for the same reason.
    cli_src = source_of(inspect.getmodule(climod.tls_status))
    for src, where in ((cli_src, "the CLI's tls-status"),
                       (source_of_route("/api/repros/{name}/tls"), "the GUI's /tls")):
        assert 'tls_terminates") or "") == "cluster"' in src, (
            f"{where} does not branch on where TLS terminates, so on a Kubernetes "
            f"workspace it probes this box instead of the name and reports a healthy "
            f"workspace as broken.")
        # And the branch has to actually probe the HOST, not loopback again.
        tree = ast.parse(src)
        loopback_calls = [n for n in ast.walk(tree)
                          if isinstance(n, ast.Call)
                          and getattr(n.func, "attr", "") == "verify"
                          and n.args and isinstance(n.args[0], ast.Constant)
                          and n.args[0].value == "127.0.0.1"]
        host_calls = [n for n in ast.walk(tree)
                      if isinstance(n, ast.Call)
                      and getattr(n.func, "attr", "") == "verify"
                      and n.args and isinstance(n.args[0], ast.Name)
                      and n.args[0].id == "host"]
        assert loopback_calls, f"{where}: the Compose path must still probe loopback"
        assert host_calls, (
            f"{where}: nothing probes the name, so the cluster-terminated case cannot "
            f"be answered correctly.")


def test_status_breakdown_non_zero_only():
    from houston import cli
    from houston.perf import report
    summary = {"status": {"2xx": 1158, "429": 61, "4xx": 0, "5xx": 41, "other": 0}}
    assert cli._status_breakdown(summary) == "2xx 1158 · 429 61 · 5xx 41"
    assert report._status_breakdown(summary) == "2xx 1158 · 429 61 · 5xx 41"
    assert cli._status_breakdown({}) == ""            # no status -> empty


def test_the_cli_reports_a_down_engine_as_preflight_not_as_a_bug(monkeypatch, tmp_path):
    """Eleven commands call `_require_docker()`, and it used to `_err()` directly —
    so the single most common failure in the tool exited 1, the one value the
    README defines as "a bug in houston".

    It delegates to the service now, so the class decides. The service test covers
    the class; this covers the delegation, which is the behaviour a script sees.

    THE WORKSPACE HAS TO EXIST. This used `--name anything` on an empty home, which
    worked only while the engine was checked before the name was resolved. The gate is
    runtime-aware now -- it cannot know which engine to ask for until it knows what it
    is being asked about -- so a name that resolves to nothing exercises the resolver
    and never reaches the engine at all.
    """
    import json as _json

    from typer.testing import CliRunner

    from houston import cli, runner as runner_mod

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ws = tmp_path / "repros" / "w"
    ws.mkdir(parents=True)
    (ws / "repro.json").write_text(_json.dumps({
        "name": "w", "project": "p", "rc_version": "8.5.1", "rc_image": "i",
        "mongo_tag": "8.0", "mongo_flavor": "official", "preset": "default",
        "root_url": "http://localhost:3001", "host_port": 3001,
        "version_source": "x", "extra": {}}))
    monkeypatch.setattr(runner_mod.host, "docker_available", lambda **_k: False)
    res = CliRunner().invoke(cli.app, ["logs", "--name", "w"])
    assert res.exit_code == 3, f"engine down exited {res.exit_code}, expected 3"
    # ...and specifically not 5, which would tell a script to keep polling for
    # something polling cannot fix.
    assert res.exit_code != 5

    # And a name that does not exist is NOT_FOUND, not ENGINE_UNAVAILABLE. Pinned
    # deliberately rather than left as a side effect of the ordering: "Docker isn't
    # running" is a worse answer than "no such workspace" when the real problem is a
    # typo, and `resolve_name` reads repro.json without asking any engine anything.
    missing = CliRunner().invoke(cli.app, ["logs", "--name", "nope"])
    assert missing.exit_code == 4, f"missing workspace exited {missing.exit_code}"


def test_stopping_an_edge_that_was_never_set_up_is_not_a_traceback(tmp_path,
                                                                   monkeypatch):
    """`edge stop` on a home with no `edge/` directory answered with a Python
    traceback:

        error: FileNotFoundError: [Errno 2] No such file or directory:
        PosixPath('/home/ubuntu/.houston/edge') - this is unhandled

    `cwd` for the compose seam is `edge_dir()`, and a home that has never had an edge
    has no such directory. `_docker` one function above it carries an explicit NEVER
    RAISES contract for exactly this class of problem, and `_compose_capture` has the
    guard too -- this was the one seam without it, and it was the one that broke.

    Hit while cleaning a shared box, which is precisely when a home has no edge.
    """
    from typer.testing import CliRunner

    from houston import cli

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    assert not fd.edge_dir().exists(), "the point of the test"

    r = CliRunner().invoke(cli.app, ["edge", "stop"])
    assert r.exception is None or isinstance(r.exception, SystemExit), r.exception
    assert "Traceback" not in (r.output or "")
    assert "nothing to stop" in (r.output or ""), r.output
    # And it must not claim the ports are free, which it knows nothing about.
    assert "are free" not in (r.output or ""), r.output


def _seed_world(monkeypatch, seen, *, busy=False):
    """`_run_seed` with its lock, login, seeder and readback replaced by recorders."""
    import contextlib
    import types

    from houston import errors, rcapi, runner
    from houston.cli import data_cmds

    @contextlib.contextmanager
    def repro_lock(name, **kw):
        if busy:
            raise errors.ConflictError(
                f"another houston process is still working on {name!r} (waited 900s). "
                "Check `houston list` and the Activity list, then retry.")
        seen.append(("lock", name))
        try:
            yield
        finally:
            seen.append(("unlock", name))

    monkeypatch.setattr(runner, "repro_lock", repro_lock)
    monkeypatch.setattr(data_cmds, "_login",
                        lambda meta: seen.append(("login",)) or rcapi.Auth("t", "u"))
    monkeypatch.setattr(data_cmds.seeder, "seed", lambda *a, **k: seen.append(("seed",)) or {
        "users": 0, "channels": 0, "messages": 0, "dms": 0})
    monkeypatch.setattr(data_cmds.lcsvc, "check_seed", lambda *a, **k: seen.append(("check",)) or {
        "ok": True, "faults": [], "extra": [], "unreadable": [], "checked": 0})
    return types.SimpleNamespace(name="w", root_url="http://localhost:3000",
                                 admin_pass="admin123", extra={})


def test_the_cli_seed_holds_the_workspace_lock_as_the_gui_seed_does(monkeypatch, capsys):
    """The CLI seed took NO lock, where the GUI's `run_seed_inline` has always taken one.

    So a `houston seed` started while a backup, an upgrade or a GUI job held the
    workspace ran into it at once -- a backup's `_Quiesced` stops Rocket.Chat for the
    dump, mid-manifest -- and then lost its record without a word, because
    `update_meta`'s own 60 s wait for that same lock timed out and `check_seed` swallows
    it. Measured with a holder of 90 s: the seed ran at once and exited 0 with repro.json
    unchanged, where the TypeScript build waited and recorded it (P21, g3-12). Held from
    the login to the readback, as that build holds it.
    """
    from houston.cli import data_cmds

    seen: list = []
    meta = _seed_world(monkeypatch, seen)
    data_cmds._run_seed(meta, "small")
    capsys.readouterr()
    assert seen == [("lock", "w"), ("login",), ("seed",), ("check",), ("unlock", "w")]


def test_a_cli_seed_that_cannot_get_the_lock_is_refused_before_any_request(monkeypatch, capsys):
    """A lock the seed cannot get is the ConflictError's own refusal, through `_fail`.

    Its class's exit code and one red line -- not a traceback from a context manager --
    and nothing sent to Rocket.Chat first, not even the login.
    """
    import pytest
    import typer

    from houston import errors
    from houston.cli import data_cmds

    seen: list = []
    meta = _seed_world(monkeypatch, seen, busy=True)
    with pytest.raises(typer.Exit) as exited:
        data_cmds._run_seed(meta, "small")
    assert exited.value.exit_code == errors.ConflictError.exit_code
    assert "another houston process is still working on 'w'" in capsys.readouterr().err
    assert seen == []
