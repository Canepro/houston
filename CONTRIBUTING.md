# Contributing to rc-repro

Short guide for teammates working on the tool itself. For *using* rc-repro, see
[README.md](README.md).

## Dev setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev,gui]"    # gui too: tests/test_web.py needs fastapi
pytest                 # pure-logic tests — no Docker needed, run in seconds
ruff check .           # real-error lint (pyflakes); not a style gate
```

Install the **`gui`** extra even if you're not touching the web GUI — without it
`tests/test_web.py` skips itself as a single "1 skipped" and you lose all of the
API/auth coverage. CI runs `ruff check` then `pytest` on every push/PR against
Python 3.11 and 3.12 (see `.github/workflows/ci.yml`).

## Project layout

| Module | Responsibility |
|--------|----------------|
| `rc_repro/cli.py` | Typer commands: option parsing, terminal rendering, CLI-only `loadtest`/`capacity`/`benchmark`/`capture`/`workloads` |
| `rc_repro/services/` | the shared "brain" both front-ends run: `lifecycle` (create/ready/teardown/prune), `perf` (GUI loadtest/capacity/benchmark), `data` (scale prefill, config-import), `monitor` (attach/detach), `postready` (preset self-config actions), `diagnose` (opaque `up` failures), `events` (the progress `Event`/`Emit` contract), `evidence` (the attachable record + its Markdown render), `capture` (scripted browser reproduction: workload parsing, the injected driver seam, trace redaction) |
| `rc_repro/web/` | the `serve` GUI: `app.py` (FastAPI routes, token + Host guard, SSE/WS) and `jobs.py` (background job registry). Imported lazily — the core CLI never depends on it |
| `rc_repro/errors.py` | `ReproError` hierarchy with `http_status`; the failure contract between services and both front-ends |
| `rc_repro/configimport.py` | parse a support-dump `*-settings.json` into an apply/skip plan, and apply it |
| `rc_repro/scaleseed.py` | bulk `--scale` MongoDB prefill (and its tagged undo) |
| `rc_repro/versions.py` | RC version → MongoDB pairing (live lookup + fallback map) |
| `rc_repro/presets/` | preset package: `__init__.py` holds the `Preset` dataclass + loader |
| `rc_repro/presets/_common.py` | shared `--set` param helpers (`truthy_param`/`int_param`/`str_param`) |
| `rc_repro/presets/_keycloak.py` | shared Keycloak scaffolding reused by `saml` + `oidc` |
| `rc_repro/presets/ldap.py`, `saml.py`, `oidc.py`, `email.py`, `s3_minio.py`, `livechat.py` | generate the LDAP / Keycloak (SAML & OIDC) / Mailpit / MinIO / Omnichannel scenarios |
| `rc_repro/presets/multi_instance.py` | generate the multi-instance (Traefik + NATS) scenario |
| `rc_repro/compose.py` | build the docker-compose document (incl. cloning RC into N instances, port binding) |
| `rc_repro/runner.py` | on-disk state, `docker compose` invocations, host-port allocation |
| `rc_repro/rcapi.py` | minimal Rocket.Chat REST client (readiness, auth, 2FA/OTP, settings) |
| `rc_repro/seed.py` | populate a repro with sample users/channels/messages via REST |
| `rc_repro/monitoring.py` | `--monitor` add-on: Prometheus + Grafana services/config, attachable to any repro |
| `rc_repro/perf/` | performance tooling: `timings` (latency percentiles), `resources` (docker-stats sampler), `k6` (load-test runner), `slo` (SLO gate parse/evaluate), `baseline` (saved runs + before/after compare), `constrain` (customer-sized CPU/RAM caps), `rcmetrics` (RC /metrics sampler: event-loop lag), `mongoprof` (Mongo slow-query capture), `timeline` (latency-over-time + spike recovery), `verdict` (rule-based diagnosis), `report` (benchmark/loadtest/capacity markdown) |
| `rc_repro/ui.py` | terminal output helpers (`ok`/`warn`/`fail`/`note`/`die`) |
| `rc_repro/config.py` | paths, constants, `PRESET_PORTS` registry, env-var overrides, persisted config |
| `rc_repro/__init__.py` | `__version__` (single-sourced from `pyproject.toml` via `importlib.metadata`) |
| `rc_repro/data/` | shipped version map, static preset YAML, monitoring dashboard JSON, k6 load-test scripts (`data/loadtest/`), GUI assets (`data/webui/`) |

## Adding a preset

**Static preset** (env / extra services only) — add a YAML file to
`rc_repro/data/presets/<name>.yaml`:

```yaml
name: my-scenario
description: What this reproduces.
env:                       # merged into the rocketchat service
  OVERWRITE_SETTING_Some_Setting: "true"
services:                  # optional extra compose services
  my-sidecar: { image: some/image:tag }
depends_on: [my-sidecar]
```

**Dynamic preset** (needs generated files, params, or post-boot steps — like
`ldap`/`saml`) — write a `build(params) -> Preset` function in a new
`rc_repro/presets/<name>.py` and register it in
`presets._dynamic_builders()` (in `rc_repro/presets/__init__.py`).

- Read `--set` params via `_common.truthy_param` / `int_param` / `str_param` so
  bad values raise a clean error instead of a traceback.
- Reuse `_keycloak` if your preset needs a Keycloak IdP.

Useful `Preset` fields:
- `files` — generated files written to the workspace (e.g. an LDIF or realm JSON).
- `params_help` — one line per `--set` key, shown by `rc-repro presets`.
- `post_ready` — actions run once RC is serving; add a handler in
  `services/postready.py`'s `_POST_READY_ACTIONS` and key it by the action's
  `"action"` string. Nothing checks that coupling automatically, so a typo'd
  action string is a silent no-op — add a test alongside the handler.
- `notes` — tips printed after `up` / by `info`.
- `ports` — host ports the preset's side services publish (see below).
- `volumes` — named volumes merged into the compose top-level `volumes:` (any
  volume a preset service mounts must be declared here or compose rejects it).
- `extra` — arbitrary metadata copied into `repro.json` (e.g. the email preset
  stores `mailpit_url` so `rcapi.login` can fetch OTP codes).

**Side-service ports.** If your preset publishes host ports, add them to
`config.PRESET_PORTS` and set `ports=list(config.PRESET_PORTS["<name>"])` on the
`Preset`. That keeps allocation collision-free (a second same-preset repro is
rejected up front) and picks a port that doesn't clash with other presets. All
published ports are bound to `127.0.0.1` automatically — don't hard-code a bind
host in the service.

## Adding a capture workload

A capture workload scripts a browser through a reproduction. It is a Workload
Scenario in `CONTEXT.md` terms: a named pattern of test activity applied to a
running reproduction. Add a YAML file to `rc_repro/data/workloads/<name>.yaml` (or
`~/.rc-repro/workloads/<name>.yaml` for a local one, which overrides a built-in of
the same name):

```yaml
name: my-repro
description: What this demonstrates.
steps:
  - goto: "/"
  - wait_for: "input[name=usernameOrEmail]"
    timeout_ms: 60000
  - shot: landing              # a named checkpoint screenshot
  - fill: "input[name=password]"
    value: "{{admin_pass}}"    # substituted for the browser, recorded unresolved
  - click: "button[type=submit]"
```

Actions are `goto` (a path joined to the repro's URL), `click`, `fill` and
`wait_for` (each a raw Playwright selector), `press` (a key name) and `shot` (a
screenshot label). The selector actions taking raw Playwright syntax is the escape
hatch that keeps an unusual reproduction from waiting on this list to grow.
`timeout_ms` overrides the 15s default on `click`, `fill` and `wait_for`, which is
what a slow boot needs. Steps run in order and a step that cannot run
aborts the capture with exit 9 — a workload is pointed at whatever version the
repro is running, so a silent miss would produce a blank screenshot that still
reads as evidence.

Never inline a credential; use `{{admin_user}}` / `{{admin_pass}}`. The manifest
records what was authored rather than what was resolved, and `capture.redact_trace`
scrubs resolved secrets out of the Playwright trace, which records every action's
arguments verbatim. Both matter because the bundle is meant to be attached to a
support case.

Anyone can also drop a preset in `~/.rc-repro/presets/<name>.yaml` locally — a
user file overrides a built-in or dynamic preset of the same name. Static YAML
supports `env`, `services`, `rocketchat`, `depends_on`, `notes`, `params_help`,
`instances`, `entry_service`, `extra`, `volumes`, `ports` (but not `files` /
`post_ready`, which are code-only).

## Conventions

- Add/adjust a test for anything you change. Four files, pick by layer:
  `tests/test_core.py` (version resolution, presets, compose, perf, seed/import),
  `tests/test_services.py` (the `services/` layer and `web/jobs.py`),
  `tests/test_web.py` (the HTTP API — needs the `gui` extra),
  `tests/test_diagnose.py` (failure-signature matching). All run without Docker;
  each test gets an isolated `RC_REPRO_HOME` via `tests/conftest.py`.
- `test_core.py`/`test_diagnose.py` use `try/except/else` for expected errors;
  `test_services.py`/`test_web.py` use `pytest.raises`. Match the file you're in.
- Keep Docker interaction in `runner.py` and REST interaction in `rcapi.py`.
- Use `ui.ok/warn/fail`/`_err` for status output rather than raw `typer.secho`.
- Check `docker compose` return codes — lifecycle commands must fail loudly, not
  print a false success.
- Verify user-facing changes with a real `up` where practical — several bugs in
  this tool only surfaced by actually running/clicking through a repro.

## Maintainer

Maintained by the Rocket.Chat support team.
Issues and requests: https://github.com/klovekesh37/rc-repro/issues
