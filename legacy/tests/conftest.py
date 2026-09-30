"""Test isolation: every test gets a fresh HOUSTON_HOME and a deterministic engine.

Without the home fixture, presets.load()/config.load_config() read the developer's real
~/.houston (or ambient HOUSTON_HOME) — a user preset override like presets/saml.yaml
would shadow the built-in and break unrelated tests.

The engine fixture exists because CLAUDE.md's "Nothing in the suite needs Docker" was
FALSE, by twenty-two tests across six files. Measured by building a PATH containing
every executable except `docker` and running the suite through it: an external review
saw a red gate where this box saw green, purely because that box had no Docker and this
one does — and GitHub's runner has it too, so CI never noticed either.

The cloud fixture exists because a test SPENT nothing only by luck. `create_cluster`
moved from `k8s.run` to a streaming runner so a twenty-minute build reports progress,
and a test still stubbing the old seam did not intercept -- so it shelled out to REAL
`eksctl` against REAL credentials, on a box where both are installed. It failed for
want of a config, which is not a safety property. A suite that can reach cloud tooling
is a suite that can create a cluster, and no amount of care at each call site makes
that untrue; the tooling is made unreachable instead.

Two seams, because `require_docker` probes both: the daemon and the compose plugin. A
test that wants the engine DOWN monkeypatches these itself in its own body, which runs
after this fixture and therefore wins. Nothing here stubs the docker INVOCATION seams
(`runner.compose_stream`, `edge._docker`); a test that reaches those still shells out,
and both now return a non-zero result rather than raising when the binary is absent.
"""

import ast
import atexit
import inspect
import os
import pathlib
import shlex
import shutil
import tempfile
import textwrap

import pytest


def source_of(obj) -> str:
    """The CURRENT source of a function, class or module, found by NAME.

    `inspect.getsource` resolves an object to a file and a recorded first line, then
    reads that range through `linecache`. Edit the file after import -- which anyone
    saving a file during this 9.5-minute suite does -- and the recorded line number no
    longer matches the new content, so it returns *the wrong lines*.

    OBSERVED, and it cost an audit an hour: three tests failed with
    `ValueError: substring not found` from `src.index("_route_kubernetes_name(")`,
    pointing nowhere near the cause, in tests whose real subject is call ordering. A
    second identical run afterwards was clean. `lifecycle.py` had gained 23 lines
    mid-run.

    Finding the definition by name in the file as it is NOW cannot go stale that way:
    there is no line number to be wrong. A module is returned whole; anything else is
    located by its `__name__` in the module's AST.
    """
    module = inspect.getmodule(obj)
    path = getattr(module, "__file__", "") if module else ""
    if inspect.ismodule(obj):
        # A PACKAGE returns all of its source, not just `__init__.py`.
        #
        # Phase 2b turns `lifecycle.py` and `k8s.py` into packages, and a guard that asks
        # for "the source of this service" means the service -- not the compatibility
        # façade, which holds no code at all. Reading only `__init__.py` does not fail;
        # it passes over nothing, which is the shape of drift this repo keeps paying for.
        if getattr(module, "__path__", None):
            root = pathlib.Path(next(iter(module.__path__)))
            return "\n".join(p.read_text(encoding="utf-8")
                              for p in sorted(root.rglob("*.py")))
        return inspect.getsource(obj)
    if not path:
        return inspect.getsource(obj)
    name = getattr(obj, "__name__", "")
    try:
        text = pathlib.Path(path).read_text()
        tree = ast.parse(text)
    except (OSError, SyntaxError):
        return inspect.getsource(obj)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) \
                and node.name == name:
            return textwrap.dedent(ast.get_source_segment(text, node) or "")
    return inspect.getsource(obj)


def source_index(src: str, needle: str, where: str = "") -> int:
    """`src.index(needle)`, failing with a message that names the cause.

    `ValueError: substring not found` is the least useful thing a source-ordering
    assertion can say, and the commonest reason for it is not the property being
    wrong -- see `source_of`.
    """
    at = src.find(needle)
    if at < 0:
        raise AssertionError(
            f"{needle!r} is not in the source of {where or 'the object under test'}. "
            f"Either the call it names has been removed or renamed -- in which case "
            f"this test is telling you something -- or the file changed during this "
            f"run, which makes source reads unreliable. Re-run before believing it.")
    return at




#: Pass as `through=` to follow the steps of whichever module defines the object -- for a
#: walk over a list of functions from different modules, where naming each one would mean
#: importing them all.
OWN_MODULE = object()


def call_sequence(obj, through=None) -> list[str]:
    """Every function `obj` calls, in execution order, following its own steps.

    A create is a plan and a dozen named steps now, so "the route is written before the
    chart installs" is no longer a claim about one function's text -- it spans three of
    them. Passing the module as `through` splices each step's own calls in at the point
    the orchestrator calls it, which reconstructs the order the tests are actually about.
    """
    if through is OWN_MODULE:
        through = inspect.getmodule(obj)
    steps = {}
    if through is not None:
        steps = {n.name: n for n in ast.parse(textwrap.dedent(source_of(through))).body
                 if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}

    def walk(node, seen):
        calls = sorted(
            (c.lineno, c.col_offset,
             getattr(c.func, "attr", None) or getattr(c.func, "id", None))
            for c in ast.walk(node) if isinstance(c, ast.Call)
            and (getattr(c.func, "attr", None) or getattr(c.func, "id", None)))
        out = []
        for _line, _col, name in calls:
            out.append(name)
            if name in steps and name not in seen:
                out += walk(steps[name], seen | {name})
        return out

    return walk(ast.parse(textwrap.dedent(source_of(obj))), frozenset())


def functions_through(obj, through=OWN_MODULE) -> list[ast.FunctionDef]:
    """`obj`'s definition, and every same-module function it reaches, as AST.

    The tree twin of `source_through`, for guards that walk structure rather than text --
    "step 0 branches on a caller-named context and every plan it builds says
    create=False" is a claim about a BRANCH, not about a substring. Pulling that branch
    into a helper must not read as deleting it.
    """
    if through is OWN_MODULE:
        through = inspect.getmodule(obj)
    steps = {n.name: n for n in ast.parse(textwrap.dedent(source_of(through))).body
             if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))} if through else {}
    root = ast.parse(textwrap.dedent(source_of(obj))).body[0]
    out, seen, queue = [], set(), [root]
    while queue:
        node = queue.pop()
        if getattr(node, "name", None) in seen:
            continue
        seen.add(getattr(node, "name", None))
        out.append(node)
        for call in ast.walk(node):
            if not isinstance(call, ast.Call):
                continue
            name = getattr(call.func, "attr", None) or getattr(call.func, "id", None)
            if name in steps and name not in seen:
                queue.append(steps[name])
    return out


def source_through(obj, through=OWN_MODULE) -> str:
    """`source_of`, plus every same-module function it reaches.

    A guard that searches one function's text for a marker -- "the drop window is
    journalled", "the token never becomes a helm value" -- stops being true the moment
    the marker moves into a helper that function calls, and it stops being true
    SILENTLY, reporting that the behaviour is gone. Six such guards broke that way when
    step 2b.15 pulled long functions apart.

    Re-derive rather than re-spell: follow the calls the way `call_sequence` does, and
    search the whole path. The guard then covers strictly more than it did, and moving
    the marker one level down no longer looks like deleting it.
    """
    if through is OWN_MODULE:
        through = inspect.getmodule(obj)
    if through is None:
        return source_of(obj)
    # REAL SOURCE, sliced from the module's own text -- not `ast.unparse`. Unparsing
    # normalises `"mongo_managed_by"` to `'mongo_managed_by'` and drops every comment,
    # so a guard asserting on a quoted key or on a comment would fail against code that
    # had not changed. The line numbers are read from a parse of the text being sliced,
    # so they cannot be stale the way `inspect`'s recorded ones can.
    whole = source_of(through)
    lines = whole.splitlines()
    steps = {n.name: n for n in ast.parse(textwrap.dedent(whole)).body
             if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}

    def text_of(node):
        return "\n".join(lines[node.lineno - 1:node.end_lineno])

    def walk(node, seen):
        out = [text_of(node) if node in steps.values() else source_of(obj)]
        for call in ast.walk(node):
            if not isinstance(call, ast.Call):
                continue
            name = getattr(call.func, "attr", None) or getattr(call.func, "id", None)
            if name in steps and name not in seen:
                out += walk(steps[name], seen | {name})
        return out

    root = steps.get(getattr(obj, "__name__", ""))
    if root is None:
        return source_of(obj)
    return "\n".join(walk(root, frozenset({root.name})))


def call_order(obj, *names, through=None) -> list[int]:
    """Where `obj` calls each named function, by NAME rather than by spelling.

    A source-ordering assertion is about the order two things happen in, not about how
    the call is written -- and during the decomposition how it is written changes
    constantly: `_up(...)` becomes `ready._up(...)` the moment `_up` moves, and a test
    matching the literal text stops testing anything while still passing, or fails for a
    reason that has nothing to do with the property. Nine such guards had to be
    re-pointed by hand in phase 02a before this existed.

    The name is matched against the last dotted segment, so `ready._up`, `lc._up` and a
    bare `_up` all count. Raises rather than returning -1, naming which call is missing.
    """
    flat = call_sequence(obj, through)
    found: list[int] = []
    for wanted in names:
        at = [i for i, name in enumerate(flat) if name == wanted]
        if not at:
            raise AssertionError(
                f"{getattr(obj, '__name__', obj)} does not call {wanted!r} at all. "
                f"Either the call has been removed -- in which case this test is telling "
                f"you something -- or it was renamed and this test needs the new name. "
                f"It is NOT about how the call is spelled: a module prefix is ignored.")
        found.append(min(at))
    return found


def source_of_route(path: str, method: str = "GET") -> str:
    """The CURRENT source of the handler answering `method path`, via the router.

    Phase 2a moved eighty handlers out of `create_app()` into `web/routes/`, and every
    test that read `houston/web/app.py` to check one went looking in a file that no
    longer holds it. One did so loudly and was fixed; another narrowed silently and kept
    passing over less code. Asking the application which function it dispatches to
    cannot go stale, whichever module the handler ends up in.

    The method matters: `/api/sessions` is two different functions depending on it, and
    matching on the path alone would silently check the wrong one.
    """
    from houston.web.app import create_app

    want = method.upper()
    route = next(r for r in create_app().routes
                 if getattr(r, "path", "") == path
                 and want in (getattr(r, "methods", None) or {"WS"}))
    return source_of(route.endpoint)


#: THE GAP BETWEEN TESTS. `_isolated_home` below is per test, and when a test ends
#: monkeypatch puts HOUSTON_HOME back to whatever pytest was started with -- in a plain
#: shell, nothing, so until the next test's setup `config.home()` IS the real ~/.houston.
#: Work a test leaves running in a thread keeps going through that gap. Measured:
#: `pytest -q` wrote a `create_unfinished` journal note for `alice-rc8-5-1` into the
#: developer's real home at 2026-09-24T04:59:31Z, one of 26 identical notes since
#: 2026-09-10. A note survives only when it is written in one home and cleared in
#: another, which is exactly a create whose `journal.record` ran in the gap and whose
#: `clear` ran after the next test had set its own home. So the process itself gets a
#: throwaway home: whatever runs outside a test's own home lands here, never there.
_SESSION_HOME = pathlib.Path(tempfile.mkdtemp(prefix="houston-pytest-session-"))
os.environ["HOUSTON_HOME"] = str(_SESSION_HOME)
atexit.register(shutil.rmtree, _SESSION_HOME, ignore_errors=True)


def pytest_terminal_summary(terminalreporter):
    """Say so when work outlived its test, rather than letting the fallback hide it."""
    stray = sorted(p.relative_to(_SESSION_HOME).as_posix()
                   for p in _SESSION_HOME.rglob("*") if p.is_file())
    if stray:
        terminalreporter.write_sep("-", "work that outlived its test wrote to the "
                                   "session fallback home, not to a real one")
        for leaf in stray[:20]:
            terminalreporter.write_line(f"  {leaf}")


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path / "houston-home"))


@pytest.fixture(autouse=True)
def _deterministic_engine(monkeypatch):
    """`require_docker()` passes by default, whatever this machine has installed.

    Not a convenience: it is what makes the suite's result the same with and without a
    docker binary, which is the property the project claims and did not have.
    """
    from houston import runner

    monkeypatch.setattr(runner.host, "docker_available", lambda **kw: True,
                        raising=False)
    monkeypatch.setattr(runner.host, "compose_version", lambda **kw: "2.29.0",
                        raising=False)


#: Every external tool the suite must treat as unreachable unless a test owns a stub.
_CLOUD = ("eksctl", "aws", "kubectl", "helm", "kind", "docker")

#: The VERBS that build or destroy, which is the distinction that matters. `eksctl
#: version` is a version probe and `aws sts get-caller-identity` is a question; both
#: are asked by an ordinary `doctor` and neither costs anything. Refusing the BINARY
#: rather than the verb broke `doctor` outright, because the tool probe it runs at
#: startup was caught in the same net as `eksctl create cluster`.
_SPENDS = ("create", "delete")

#: Everything else these tools are asked is a QUESTION, and the honest stand-in is
#: "it could not be answered" -- a state every caller already handles, and one that
#: does not explode underneath a `doctor` that was only looking. Raising instead broke
#: fifteen tests with nothing to do with the cloud, and then a sixteenth.
_FORBIDDEN = _CLOUD
_STUB_POINT = {
    "eksctl": "eks.aws._stream", "aws": "eks.aws._stream",
    "kubectl": "k8s.run", "helm": "k8s.run", "kind": "k8s.run",
    "docker": "the owning runner or edge process wrapper",
}


@pytest.fixture(autouse=True)
def _no_cloud_tooling(monkeypatch):
    """The suite cannot invoke infrastructure tooling unless a test owns a stub.

    This is a guard rail, not a convenience: `eksctl create cluster` builds real
    infrastructure and bills for it, and the difference between a test that stubs the
    right seam and one that stubs the seam that USED to be right is invisible until
    something has already been created. A test that means to exercise those paths
    stubs the function that calls them, which runs after this fixture and wins.

    ABSENT, not merely blocked. Raising on the subprocess is not enough: `k8s.run`
    catches OSError and SubprocessError, so a guard raising anything else escapes and
    breaks every caller that was only asking a question -- fifteen tests, none of them
    about the cloud, failed that way. The suite therefore reports these tools as NOT
    INSTALLED, which is a state the code already handles everywhere and the same
    treatment the fixture above gives Docker in the other direction.

    A test that needs one present says so itself: its own `monkeypatch` runs after
    this fixture and wins, and the tests that assert version floors build `Tool`
    objects directly rather than probing.
    """
    from houston import exec as process

    real_run, real_popen = process.run, process.popen

    def _words(args) -> list[str]:
        if isinstance(args, (list, tuple)):
            return [str(x) for x in args]
        if isinstance(args, str):
            try:
                return shlex.split(args)
            except ValueError:
                return args.split()
        return []

    def guard(fn, *, streaming: bool):
        def wrapped(args, *a, **kw):
            words = _words(args)
            name = words[0].rsplit("/", 1)[-1] if words else ""
            if name not in _CLOUD:
                return fn(args, *a, **kw)
            rest = words[1:]
            if any(verb in rest for verb in _SPENDS):
                action = "stream" if streaming else "run"
                raise AssertionError(
                    f"the test suite tried to {action} `{name} {' '.join(rest[:3])}`, which "
                    f"creates or destroys real infrastructure and bills for it. Stub "
                    f"{_STUB_POINT[name]} rather than the process seam "
                    f"underneath.")
            return process.CompletedProcess(
                args, 127, "", f"{name} is unavailable in the test suite")
        return wrapped

    monkeypatch.setattr(process, "run", guard(real_run, streaming=False))
    monkeypatch.setattr(process, "popen", guard(real_popen, streaming=True))
