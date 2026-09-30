"""`houston.browser.kubernetes_offstage`: its own spec file.

Co-located out of `tests/test_browser.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("playwright.sync_api")

from browserhelpers import _fake_detail

def _the_real_detail_payload(monkeypatch, tmp_path):
    """What `lifecycle.detail()` actually returns, built from stubs of what it reads."""
    import json as _json

    from houston import runner
    from houston.services import k8s as k8ssvc
    from houston.services import lifecycle as lcsvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    (tmp_path / "repros" / "cmp").mkdir(parents=True)
    (tmp_path / "repros" / "cmp" / "repro.json").write_text(_json.dumps({
        "name": "cmp", "project": "p", "rc_version": "7.4.1", "rc_image": "i",
        "mongo_tag": "7.0", "mongo_flavor": "official", "preset": "default",
        "root_url": "http://localhost:3001", "host_port": 3001,
        "version_source": "x", "extra": {}}))
    (tmp_path / "repros" / "cmp" / "docker-compose.yml").write_text(
        "services:\n  rocketchat:\n    image: i\n    ports:\n"
        "    - 127.0.0.1:3001:3000\n    environment:\n      ROOT_URL: x\n")
    (tmp_path / "repros" / "kub").mkdir(parents=True)
    (tmp_path / "repros" / "kub" / "repro.json").write_text(_json.dumps({
        "name": "kub", "project": "p", "rc_version": "7.4.1", "rc_image": "i",
        "mongo_tag": "7.0", "mongo_flavor": "official", "preset": "default",
        "root_url": "http://localhost:3002", "host_port": 3002,
        "version_source": "x",
        "extra": {"runtime": "kubernetes", "namespace": "houston-kub"}}))
    # A MULTI-INSTANCE workspace, because `instances`/`instance_urls` are only added
    # when the record carries a count -- and with `extra: {}` this walk could not see
    # them. Its own panel is the one nothing else covers.
    (tmp_path / "repros" / "multi").mkdir(parents=True)
    (tmp_path / "repros" / "multi" / "repro.json").write_text(_json.dumps({
        "name": "multi", "project": "p", "rc_version": "7.4.1", "rc_image": "i",
        "mongo_tag": "7.0", "mongo_flavor": "official", "preset": "multi-instance",
        "root_url": "http://localhost:3003", "host_port": 3003,
        "version_source": "x", "extra": {"instances": 3}}))
    (tmp_path / "repros" / "multi" / "docker-compose.yml").write_text(
        "services:\n  rocketchat:\n    image: i\n    ports:\n"
        "    - 127.0.0.1:3003:3000\n    environment:\n      ROOT_URL: x\n")

    monkeypatch.setattr(lcsvc.inspect, "kubernetes_state", lambda name, meta: "running")
    monkeypatch.setattr(k8ssvc.status, "pod_rows", lambda name, **kw: [])

    fake = _fake_detail()
    return fake, lcsvc, runner


def test_fake_detail_matches_the_real_payload(monkeypatch, tmp_path):
    """The payload-shape trap, closed. Every browser test above renders from
    `_fake_detail`, so a key that differs from what `lifecycle.detail()` really
    returns breaks the panel in production with this whole file green. It had drifted
    on three keys before this existed.

    Both branches of detail() are compared, because they do not return the same set.
    """
    fake, lcsvc, runner = _the_real_detail_payload(monkeypatch, tmp_path)
    # BOTH VALUES OF docker_available, because they do not return the same set and
    # PRODUCTION TAKES THE TRUE ONE. Stubbing only False hid `degraded`, which
    # `detail` adds from the container list -- so the guard that exists to catch
    # fixture drift could not see the key that had drifted.
    seen = set()
    for available in (False, True):
        monkeypatch.setattr(runner.host, "docker_available",
                            (lambda _a: lambda **_k: _a)(available))
        # No daemon from a unit test: `ps` is the only thing the True branch would
        # otherwise shell out to.
        monkeypatch.setattr(runner.engine, "ps", lambda *a, **k: "")
        for name in ("cmp", "kub", "multi"):
            seen.add((available, name))
            real = lcsvc.detail(name)
            missing = sorted(set(real) - set(fake))
            assert not missing, (
                f"detail({name!r}) with docker_available={available} returns keys "
                f"the browser fixture does not have: {missing} — every test in this "
                f"file renders from the fixture, so the panel can break in "
                f"production with this file green")
            for key in sorted(set(real) & set(fake)):
                if real[key] is None or fake[key] is None:
                    continue
                assert type(real[key]) is type(fake[key]), (
                    f"detail({name!r})[{key!r}] is {type(real[key]).__name__}, the "
                    f"fixture has {type(fake[key]).__name__}")
    assert seen == {(available, name) for available in (False, True)
                    for name in ("cmp", "kub", "multi")}


def test_the_restart_count_on_kubernetes_is_rocket_chats_own_pod(monkeypatch, tmp_path):
    """`app` is decided in services/k8s.py from the label APP_SELECTOR already names,
    never from a substring of the pod name -- the browser would then hold a second copy
    of a naming rule, and on microservices every pod's name starts with the release.
    """
    import json as _json

    from houston import runner
    from houston.services import k8s as k8ssvc
    from houston.services import lifecycle as lcsvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    (tmp_path / "repros" / "kub").mkdir(parents=True)
    (tmp_path / "repros" / "kub" / "repro.json").write_text(_json.dumps({
        "name": "kub", "project": "p", "rc_version": "8.5.1", "rc_image": "i",
        "mongo_tag": "8.0", "mongo_flavor": "official", "preset": "default",
        "root_url": "http://localhost:3131", "host_port": 3131, "version_source": "x",
        "extra": {"runtime": "kubernetes", "namespace": "houston-kub",
                  "release": "rocketchat"}}))
    monkeypatch.setattr(runner.host, "docker_available", lambda **_k: False)
    monkeypatch.setattr(lcsvc.inspect, "kubernetes_state", lambda name, meta: "running")
    monkeypatch.setattr(k8ssvc.status, "pod_rows", lambda name, **kw: [
        {"service": "rocketchat-ddp-streamer-x", "state": "running", "status": "",
         "health": "", "app": False, "restarts": 3, "started": ""},
        {"service": "rocketchat-rocketchat-y", "state": "running", "status": "",
         "health": "healthy", "app": True, "restarts": 1, "started": ""}])
    # Rocket.Chat's own, not the worst in the namespace.
    assert lcsvc.detail("kub")["restarts"] == 1
