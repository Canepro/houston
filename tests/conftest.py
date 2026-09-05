"""Test isolation: every test gets a fresh RC_REPRO_HOME and a deterministic engine.

Without the home fixture, presets.load()/config.load_config() read the developer's real
~/.rc-repro (or ambient RC_REPRO_HOME) — a user preset override like presets/saml.yaml
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
import inspect
import pathlib
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
    if inspect.ismodule(obj) or not path:
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




@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("RC_REPRO_HOME", str(tmp_path / "rc-repro-home"))


@pytest.fixture(autouse=True)
def _deterministic_engine(monkeypatch):
    """`require_docker()` passes by default, whatever this machine has installed.

    Not a convenience: it is what makes the suite's result the same with and without a
    docker binary, which is the property the project claims and did not have.
    """
    from rc_repro import runner

    monkeypatch.setattr(runner, "docker_available", lambda **kw: True,
                        raising=False)
    monkeypatch.setattr(runner, "compose_version", lambda **kw: "2.29.0",
                        raising=False)


#: The binaries that can reach a cloud account at all.
_CLOUD = ("eksctl", "aws")

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


@pytest.fixture(autouse=True)
def _no_cloud_tooling(monkeypatch):
    """The suite cannot invoke `eksctl` or `aws`, whatever a test forgets to stub.

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
    import subprocess

    real_run, real_popen = subprocess.run, subprocess.Popen

    def _argv0(args):
        if isinstance(args, (list, tuple)) and args:
            return str(args[0]).rsplit("/", 1)[-1]
        if isinstance(args, str):
            return args.split()[0].rsplit("/", 1)[-1]
        return ""

    def guard(fn, *, streaming: bool):
        def wrapped(args, *a, **kw):
            name = _argv0(args)
            if name not in _CLOUD:
                return fn(args, *a, **kw)
            rest = [str(x) for x in (args[1:] if isinstance(args, (list, tuple)) else [])]
            if any(verb in rest for verb in _SPENDS):
                raise AssertionError(
                    f"the test suite tried to run `{name} {' '.join(rest[:3])}`, which "
                    f"creates or destroys real infrastructure and bills for it. Stub "
                    f"the function that calls it (`eks._stream`) rather than the seam "
                    f"underneath.")
            if streaming:
                raise AssertionError(
                    f"the test suite tried to stream {name!r}; stub `eks._stream`")
            return subprocess.CompletedProcess(
                args, 1, "", f"{name} is unavailable in the test suite")
        return wrapped

    monkeypatch.setattr(subprocess, "run", guard(real_run, streaming=False))
    monkeypatch.setattr(subprocess, "Popen", guard(real_popen, streaming=True))


