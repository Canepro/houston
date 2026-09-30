"""`houston.services.k8s`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from conftest import source_of
from servicehelpers import _FALSEY_ON_FAILURE_ALLOWED


def test_no_kubectl_read_answers_a_failed_call_with_an_empty_one():
    """The fourth registry walk, and the one this release kept needing.

    `if res.returncode != 0: return []` is indistinguishable from "the cluster holds
    none of these", and every instance of it has cost something: `workspace_namespaces`
    uninstalled the SHARED monitoring stack and MongoDB operator out from under other
    workspaces and made a failed create delete a namespace `down` had kept -- PVC and
    all -- while `list` reported a healthy workspace as `down`. `storage_classes`,
    `ingress_classes` and `nodes_summary` told somebody with a working cluster they
    had no storage, no ingress and no nodes.

    Those were found one at a time, by hand, over four releases. The registries that
    have a walk behind them -- ROUTE_ROLES against app.routes, and the PHASES source
    walk -- have never drifted; this is the same idea for the shape rather than for a
    table. A new read that reaches for `return []` on failure now has to either carry
    the third answer or say in `_FALSEY_ON_FAILURE_ALLOWED` why it does not.
    """
    import ast

    from houston.services import k8s

    tree = ast.parse(source_of(k8s))
    offenders = []
    for fn in [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]:
        if fn.name in _FALSEY_ON_FAILURE_ALLOWED:
            continue
        # A signature that admits None is declaring the third answer, so returning it
        # is the fix rather than the defect. This is what makes the walk teach the
        # pattern instead of just forbidding a token.
        annotation = ast.unparse(fn.returns) if fn.returns is not None else ""
        if "None" in annotation:
            continue
        for node in ast.walk(fn):
            if not isinstance(node, ast.If):
                continue
            test = node.test
            if not (isinstance(test, ast.Compare)
                    and isinstance(test.left, ast.Attribute)
                    and test.left.attr == "returncode"
                    and isinstance(test.ops[0], ast.NotEq)):
                continue
            body = [st for st in node.body if not isinstance(st, ast.Pass)]
            if len(body) != 1 or not isinstance(body[0], ast.Return):
                continue
            val = body[0].value
            empty_literal = (
                val is None
                or (isinstance(val, ast.Constant) and not val.value)
                or (isinstance(val, (ast.List, ast.Dict, ast.Tuple, ast.Set))
                    and not getattr(val, "elts", None)
                    and not getattr(val, "keys", None)))
            if empty_literal:
                offenders.append(f"{fn.name} (line {node.lineno}) -> "
                                 f"{ast.unparse(val) if val is not None else 'None'}")
    assert not offenders, (
        "these read a failed call as a negative answer; carry the third answer or "
        "add the function to _FALSEY_ON_FAILURE_ALLOWED with the reason:\n  "
        + "\n  ".join(offenders))


def test_no_call_site_re_implements_which_kubeconfig_to_use():
    """A rule repeated at eight sites is a rule that will be fixed at one of them.

    `owned_env() if is_ours(context) else None` was written out at eight places: once
    in `run()` and once each in apply, helm install, helm upgrade, port-forward, logs,
    exec-in and exec-out. When the kubeconfig resolution was fixed — so that houston's
    view of a kubeconfig stops depending on which kubectl BINARY is installed — the fix
    reached `run()` and none of the other seven. The preflight would pass on an EKS
    context and the first `kubectl apply` would fail on the very context it had just
    found.

    Walked rather than remembered, the same way `ROUTE_ROLES`, `PHASES` and
    `doctor.CHECKS` are: prose saying "always use the helper" is what was there before.
    """

    from houston.services import k8s

    src = source_of(k8s)
    body = src.split("def env_for(", 1)[1].split("\ndef ", 1)[0]

    # The rule appears in env_for -- that is where it belongs -- and nowhere else.
    everywhere = src.count("owned_env() if is_ours")
    inside = body.count("owned_env() if is_ours")
    assert everywhere == inside, (
        f"{everywhere - inside} call site(s) re-implement the kubeconfig rule instead "
        f"of calling env_for(); a fix to it will reach env_for and miss them")

    # And nothing passes a bare None for a context it did not resolve.
    assert "env=owned_env() if is_ours(context) else None" not in src
