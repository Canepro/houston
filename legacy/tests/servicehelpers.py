"""Helpers the specs split out of `tests/test_services.py` share, lifted whole.

Imported by name, the way these tests already import from `conftest`. The ones
that are CALLED need nothing more than that; a fixture, which is REQUESTED by
parameter name, is discovered in whatever module namespace it is imported into,
so it travels the same way and carries a `# noqa` where nothing reads the name.
Phase 02b requires the root `conftest.py` to stay as it is.
"""
from __future__ import annotations
from houston.services import lifecycle as lc
import json


# --- job manager (web/jobs.py; no fastapi needed) ----------------------------

def _await_finish(job, tries: int = 400) -> None:
    import time
    for _ in range(tries):
        if job.status != "running":
            return
        time.sleep(0.01)
    raise AssertionError(f"job {job.id} never finished")


# --- --https flag resolution --------------------------------------------------


def _req(**kw):
    base = dict(version="8.6.1")
    base.update(kw)
    return lc.CreateReq(**base)


# --- the challenge is derived, never asked for (#https-dns01) ---------------------

def _dns_env(tmp_path, body="CF_DNS_API_TOKEN=secret\n"):
    from houston import tls
    path = tls.dns_env_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


# --- host capacity (an OOM took a 10 GB box down) --------------------------------
# Seven concurrent Rocket.Chat + MongoDB stacks exhausted a 10 GB host with no
# swap: the kernel OOM killer fired and the machine had to be recovered. Every
# individual `up` had succeeded -- nothing anywhere asked whether there was room
# for one more. docs/design/team-server.md §8 recorded this as "made visible, not
# solved"; these pin the guard that solves it.

def _mem(monkeypatch, available_mb, total_mb=10000, swap_mb=0):
    from houston import runner
    monkeypatch.setattr(runner.host, "host_memory",
                        lambda: (total_mb, available_mb, swap_mb))


# --- the Kubernetes preflight ---------------------------------------------------
# Phase 3 rung 1: `doctor` learns Kubernetes. Nothing here creates anything -- every
# function is a read, so these tests drive the whole surface with `k8s.run` stubbed.

def _fake_run(mapping):
    """Stub k8s.run: match on a substring of the joined argv."""
    import subprocess as sp

    def run(argv, timeout=None, own=False, env=None, input=None):
        # `env=` BECAUSE THE REAL ONE TAKES IT. This signature drifted: two probes in
        # the kubernetes block pass `env=helm_env(...)`, and a fake without the
        # parameter raises TypeError out of `k8s.preflight`, which doctor's outer
        # `except` swallows -- so the WHOLE kubernetes section silently vanished from
        # the report these tests then asserted over. The chart-repo probe has been
        # unexercised here for that reason; it is wrapped in its own bare `except`, so
        # nothing ever failed to say so.
        joined = " ".join(argv)
        # HELM REACHES THE CLUSTER unless a test says otherwise. `helm_reachable`
        # reports whatever a non-zero exit said, and "no stub" from the fallback below
        # would put a `fail` row in every doctor test that never mentioned helm. A
        # mapping that wants an UNREACHABLE helm says so with its own `helm list` key.
        if joined.startswith("helm list") and not any("helm list" in n for n in mapping):
            return sp.CompletedProcess(argv, 0, "", "")
        # A NAMESPACE-LABELS QUERY WITH NO STUB MEANS THE NAMESPACE IS NOT THERE,
        # which is what a create test is describing. Answered before the mapping
        # because the natural `"get namespace"` entry matches this query too, and
        # rc=0 with an empty body now reads as "exists, carrying no labels" -- an
        # unlabelled namespace is refused rather than adopted, since houston cannot
        # tell one an older version made from one somebody else made. A mapping that
        # wants to describe an EXISTING namespace says so with a `labels` key.
        if "{.metadata.labels}" in joined and not any("labels" in n for n in mapping):
            return sp.CompletedProcess(
                argv, 1, "",
                'Error from server (NotFound): namespaces "x" not found')
        for needle, (rc, out) in mapping.items():
            if needle in joined:
                return sp.CompletedProcess(argv, rc, out, "")
        return sp.CompletedProcess(argv, 1, "", "no stub")
    return run


def _svc(ns, name, kind, *, port=443, node_port=None, address=""):
    """One Service, shaped as `kubectl get svc -A -o json` really returns it."""
    entry = {"port": port, "name": "https"}
    if node_port is not None:
        entry["nodePort"] = node_port
    doc = {"metadata": {"namespace": ns, "name": name},
           "spec": {"type": kind, "ports": [entry]}}
    if address:
        doc["status"] = {"loadBalancer": {"ingress": [{"ip": address}]}}
    return doc


def _svc_reader(monkeypatch, items, *, rc=0, stderr=""):
    """Stub the ONE seam every cluster read goes through, and record the argv."""
    import subprocess as sp

    from houston.services import k8s

    seen: list[list[str]] = []

    def spy(argv, timeout=None, own=False, env=None, input=None):
        seen.append(argv)
        if "nodes" in argv:
            body = {"items": [{"status": {"addresses": [
                {"type": "Hostname", "address": "docker-01"},
                {"type": "InternalIP", "address": "172.16.0.2"}]}}]}
            return sp.CompletedProcess(argv, 0, json.dumps(body), "")
        return sp.CompletedProcess(argv, rc, json.dumps({"items": items}) if not rc
                                  else "", stderr)

    monkeypatch.setattr(k8s.kube, "run", spy)
    return seen


# --- --https on Kubernetes: the refusals, which are the feature -------------------

def _kube_tls_env(monkeypatch, *, ingress=("traefik",), cert_manager=True,
                  distribution="k3s", endpoint="present", claims=(),
                  ingress_class=None):
    """Stub the cluster reads `_kubernetes_tls_plan` makes. Nothing runs kubectl.

    That sentence was aspirational. `ensure_ingress` was NOT stubbed here -- each
    test was expected to do it -- and three did not, so they called the real one,
    which reads IngressClasses through kubectl. On a box with a reachable cluster
    that returns a class and the tests pass; on a box without one it raises

        DockerError: could not read the IngressClasses in cluster 'default' ...
        refusing to guess

    and they fail. So they passed here and failed on a clean machine, which is the
    worst way for a test to be wrong: the suite was green wherever it was written.

    `ingress_class` is what `ensure_ingress` returns -- by default the first class
    the cluster is said to have, which is what adopting one does. Pass it explicitly
    to describe an INSTALL, where the class that appears is not the one the earlier
    probe saw.
    """
    from houston.services import k8s

    pre = k8s.Preflight(context="default", cluster_reachable=True,
                        ingress_classes=list(ingress), distribution=distribution,
                        provider=k8s.PROVIDER_EXTERNAL)
    monkeypatch.setattr(k8s.probe, "preflight", lambda ctx="": pre)
    _cls = ingress_class if ingress_class is not None else (
        list(ingress)[0] if ingress else "traefik")
    monkeypatch.setattr(k8s.ingress, "ensure_ingress", lambda **kw: _cls)
    # And helm's own reachability, for the same reason: it shells out, so a box with
    # a cluster answers "" and a box without one answers with an error that refuses
    # the create.
    monkeypatch.setattr(k8s.reachability, "helm_reachable", lambda ctx: "")
    monkeypatch.setattr(k8s.certmanager, "cert_manager_installed", lambda ctx: cert_manager)
    # Adopt-or-install is exercised in its own tests; here it must not reach a cluster.
    monkeypatch.setattr(k8s.certmanager, "ensure_cert_manager", lambda **kw: None)
    ep = (k8s.IngressEndpoint(address="172.16.0.2", port=443, source="loadbalancer",
                              service="kube-system/traefik", local=True)
          if endpoint == "present" else None)
    monkeypatch.setattr(k8s.endpoints, "ingress_endpoint", lambda ctx, **kw: ep)
    monkeypatch.setattr(k8s.endpoints, "host_port_claim", lambda ctx, **kw: (
        k8s.PortClaim(context=ctx, service="kube-system/traefik",
                      address="172.16.0.2", ports=list(claims)) if claims else None))
    return k8s.ClusterPlan(context="default", distribution=distribution, create=False)


def _local_spec(host="ws.houston.localhost"):
    from houston import tls as tlsmod
    return tlsmod.TlsSpec(mode=tlsmod.MODE_LOCAL, host=host, port=443)


def _legacy_home(root, *, runtime="kubernetes"):
    """A pre-rename ~/.rc-repro with one workspace, a state marker and an event log."""
    import json as _json

    legacy = root / ".rc-repro"
    (legacy / "repros" / "w1").mkdir(parents=True)
    (legacy / "logs").mkdir()
    (legacy / "repros" / "w1" / "repro.json").write_text(_json.dumps({
        "name": "w1", "project": "rcrepro-w1", "rc_version": "8.5.1", "rc_image": "rc",
        "mongo_tag": "7.0", "mongo_flavor": "official", "preset": "default",
        "root_url": "http://localhost:3000", "host_port": 3000,
        "version_source": "live", "public_url": "https://w1.rcrepro.localhost",
        "extra": {"runtime": runtime, "tls": "local"}}))
    (legacy / "sessions").write_text(
        "# rc-repro GUI sessions.\n# rc-repro-state: 2\n")
    (legacy / "logs" / "rc-repro.log").write_text('{"ts":"old"}\n')
    return legacy


def _quoted_houston_commands() -> "list[tuple[str, str]]":
    """Every `houston <something>` this package tells a person to run, with its file."""
    import pathlib
    import re

    import houston

    root = pathlib.Path(houston.__file__).parent
    found = []
    for path in sorted(root.rglob("*.py")):
        # BACKTICKED only. This file's convention is that a backtick means "run
        # this", and prose mentions the tool by name constantly -- "another houston
        # edge is already running" is a sentence, not an instruction, and matching it
        # would make the check noisy enough to be switched off.
        for m in re.finditer(r"`houston ([a-z][a-z0-9-]*)",
                             path.read_text(encoding="utf-8")):
            found.append((m.group(1), path.name))
    return found


# --- the panel, against a Kubernetes workspace ---------------------------------------

def _kube_workspace(tmp_path, monkeypatch, name="k", preset="ldap", extra=None):
    """A recorded Kubernetes workspace on disk, with NO compose file.

    The absence of the compose file is the condition every defect below shared: each
    of these code paths reached for it, and each answered with something outside the
    ReproError contract when it was not there.
    """
    import json as _json
    from dataclasses import asdict

    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name=name, project="p", rc_version="8.6.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official", preset=preset,
                           root_url="http://localhost:3010", host_port=3010,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra.update({"context": k8s.CONTEXT, "namespace": f"houston-{name}",
                    "bind_host": "127.0.0.1", **(extra or {})})
    ws = lc.runner.workspace(name)
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")
    assert not (ws / "docker-compose.yml").exists()
    return m


class _FakeProc:
    """A `Popen` double that can answer `poll()`, because the code now asks.

    `port_forward` used to return `proc.pid` the instant it spawned, so a stub with
    nothing but a `pid` was enough. It now confirms the child actually got the socket
    -- kubectl exits within milliseconds when the port is taken, and returning that
    pid recorded a dead process while a squatter served the URL. A double without
    `poll()` cannot express either outcome.
    """

    def __init__(self, pid: int, exited: int | None = None):
        self.pid = pid
        self._exited = exited

    def poll(self):
        return self._exited


def _helm_list(*names: str, status: str = "deployed", revision: int = 1) -> str:
    """What `helm list -o json` really returns, for a stub that must not lie.

    The stubs here answered with the bare release name, which is the `-q` shape.
    `release_state` asks for `-o json` because a release has a STATUS and `-q` throws
    it away -- a `pending-install` release is listed by `-q` identically to a healthy
    one, which is how a wedged release read as a working one. A stub that keeps
    answering in the old shape would make the fix look broken here and leave it
    broken in production, which is this repo's payload-shape trap in a new place.
    """
    return json.dumps([{"name": nm, "namespace": "ns", "revision": revision,
                        "updated": "2026-08-24 00:00:00", "status": status,
                        "chart": "c-1.0.0", "app_version": "1.0.0"}
                       for nm in names if nm])


def _k8s_meta(**extra):
    """A Kubernetes workspace record, as `repro.json` holds one."""
    base = {"runtime": "kubernetes", "deployment": "microservices",
            "namespace": "houston-old", "context": "kind-houston-local",
            "release": "rocketchat", "bind_host": "127.0.0.1",
            "mongo_managed_by": "statefulset", "mongo_image": "mongo:8.0"}
    base.update(extra)
    return lc.runner.Metadata(
        name="old", project="houston-old", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="default",
        root_url="http://localhost:3000", host_port=3000, version_source="map",
        extra=base)


#: Functions in `services/k8s.py` allowed to answer a FAILED call with an empty or
#: falsey value. Each one is a decision, not an oversight, and the reason is here so
#: the next reader does not have to re-derive it:
#:
#:   workspace_ready       False means "not ready yet", so the caller keeps waiting.
#:   terminal_pod_failure  None means "no terminal failure found", so it keeps waiting.
#:   pod_rows              display only; nothing branches on it.
#:   workspace_pvcs        one caller, and only to say how many volumes will go.
#:   container_security_context  {} means "no override", the conservative default,
#:                         and a chart nobody can read fails the install anyway.
#:
#: A function whose return type ALREADY admits `None` is exempt without being listed:
#: `-> list[str] | None` is how this module says "and I might not be able to ask", so
#: `return None` there is the third answer rather than a missing one.
_FALSEY_ON_FAILURE_ALLOWED = frozenset({
    "workspace_ready", "pod_rows", "workspace_pvcs", "container_security_context",
    # `_pods_waiting` returns a PROGRESS LINE, not a finding. "" means "say nothing
    # this tick" and the only caller skips the emit on it -- nothing reads it as a
    # claim that the namespace holds no pods, and no decision is taken on it. It runs
    # beside an install that is going perfectly well, so the alternative -- carrying a
    # third answer up into a log line -- would put "I could not ask about the pods" on
    # screen during a create that is fine.
    "_pods_waiting",
})


def _kube_probe_stubs(monkeypatch, *, kind: bool, our_cluster: bool, active: str,
                      reachable: bool = True, reach_status: str = ""):
    """The four facts `plan_cluster` reads, stated instead of probed.

    BOTH reachability seams are stubbed. `reachable()` is the bool the resolution
    order uses and `reach()` is the four-way answer the refusal messages carry; they
    are the same probe and a test that stated one and left the other to run for real
    would drive a live `kubectl` from a unit test.
    """
    from houston.services import k8s
    monkeypatch.setattr(k8s.tools, "which", lambda t: "/usr/bin/kind" if (t == "kind" and kind) else "")
    monkeypatch.setattr(k8s.context, "clusters",
                        lambda: ([k8s.CLUSTER_NAME] if our_cluster else [], ""))
    monkeypatch.setattr(k8s.context, "cluster_context",
                        lambda: k8s.CONTEXT if our_cluster else "")
    monkeypatch.setattr(k8s.context, "active_context", lambda: active)
    monkeypatch.setattr(k8s.reachability, "reachable", lambda ctx=None: reachable)
    status = reach_status or (k8s.REACH_OK if reachable else k8s.REACH_DOWN)
    monkeypatch.setattr(k8s.reachability, "reach",
                        lambda ctx=None, timeout=None: k8s.Reach(status=status))
    monkeypatch.setattr(k8s.context, "distribution", lambda ctx: "k3s")


def _aws_ready(monkeypatch, account="123456789012"):
    """A box that could build a cluster: tools present, signed in, region set."""
    from houston.services import eks, k8s
    tool = k8s.Tool(name="x", path="/usr/bin/x", version=(9, 9))
    monkeypatch.setattr(eks.aws, "preflight", lambda: eks.CloudPreflight(
        tools={"aws": tool, "eksctl": tool},
        identity=eks.Identity(account=account,
                              arn=f"arn:aws:iam::{account}:user/support-bot"),
        region="eu-west-1"))


def _k8s_svc_json(*services):
    """A `kubectl get svc -A -o json` document, as kubectl really shapes it."""
    import json
    return json.dumps({"items": list(services)})


def _lb(name, ns, addr, ports, kind="LoadBalancer"):
    return {"metadata": {"name": name, "namespace": ns},
            "spec": {"type": kind, "ports": [{"port": p} for p in ports]},
            "status": {"loadBalancer": {"ingress": [{"ip": addr}] if addr else []}}}


def _idp_meta(preset: str = "oidc"):
    from houston.services import postready
    return postready.runner.Metadata(
        name="w", project="p", rc_version="8.5.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset=preset, root_url="http://localhost:3001",
        host_port=3001, version_source="t")


def _completed(rc=0, out="", err=""):
    import subprocess
    return subprocess.CompletedProcess(args=["kubectl"], returncode=rc,
                                       stdout=out, stderr=err)


# --- the per-workspace admin password -----------------------------------------
# `config.ADMIN_PASSWORD` is `admin123` and `config.DEFAULT_BIND_HOST`'s own comment
# states why that is acceptable: nothing outside this machine can reach a loopback
# workspace. `--domain` removes that premise -- the edge answers for a name anybody
# on the internet can resolve -- and the credential did not change with it.

def _pin_edge(monkeypatch):
    """The edge, stubbed at its Docker seam.

    `foreign_edge` and `ensure_running` both shell out, and on a developer box with a
    real edge running the preflight answers truthfully and refuses the create -- so
    these tests would pass or fail by machine. Nothing in this suite needs Docker.
    """
    monkeypatch.setattr(lc.edgesvc.engine, "foreign_edge", lambda: "")
    monkeypatch.setattr(lc.edgesvc.runtime, "ensure_running",
                        lambda **k: type("S", (), {"ok": True, "why": "", "started": True,
                                                   "note": ""})())
    monkeypatch.setattr(lc.edgesvc.routes, "register", lambda *a, **k: False)
    monkeypatch.setattr(lc.edgesvc.acme, "issue_local_cert", lambda *a, **k: None)
    monkeypatch.setattr(lc.edgesvc.routes, "host_owner", lambda *a, **k: "")


def _capture_create(monkeypatch):
    """The create path with Docker stubbed at the seam, capturing record + compose."""
    from houston import config, tls as tlsmod  # noqa: F401
    seen: dict = {}
    monkeypatch.setattr(lc.runner.host, "docker_available", lambda **_k: True)
    monkeypatch.setattr(lc.runner.paths, "exists", lambda _n: False)
    monkeypatch.setattr(lc.sizing, "check_capacity", lambda *a, **k: None)
    monkeypatch.setattr(lc.ports, "check_sidecar_ports", lambda *a, **k: None)
    monkeypatch.setattr(lc.ports, "pick_host_port", lambda *a, **k: 3001)
    _real = lc.versions.resolve
    monkeypatch.setattr(lc.versions, "resolve",
                        lambda v, offline=False: _real(v, offline=True))
    monkeypatch.setattr(lc.runner.record, "write",
                        lambda name, yaml_, meta, files=None:
                        seen.update(meta=meta, yaml=yaml_))
    monkeypatch.setattr(lc.ready, "_up", lambda *a, **k: 0)
    return seen


# --- the Kubernetes audit's findings (K-01 .. K-24) -----------------------------

def _cluster_env(monkeypatch, *, reachable, held):
    """houston's own kind cluster, present, with `held` workspace namespaces."""
    from houston.services import k8s
    calls: list = []
    monkeypatch.setattr(k8s.kube, "run",
                        lambda argv, **kw: calls.append(argv) or _completed(0))
    monkeypatch.setattr(k8s.tools, "which", lambda b: "/usr/bin/kind")
    monkeypatch.setattr(k8s.context, "clusters", lambda: ([k8s.CLUSTER_NAME], ""))
    monkeypatch.setattr(k8s.context, "cluster_context", lambda: "kind-houston-local")
    monkeypatch.setattr(k8s.reachability, "reachable", lambda ctx, **kw: reachable)
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda ctx=None: held)
    return calls


def _crd(release: str = "", namespace: str = "") -> dict:
    """A MongoDBCommunity CRD document, optionally stamped as a helm release's."""
    ann = {}
    if release:
        ann = {"meta.helm.sh/release-name": release,
               "meta.helm.sh/release-namespace": namespace}
    return {"metadata": {"name": "mongodbcommunity.mongodb.com", "annotations": ann}}
