# Attachable evidence

Applicability is the exact `evidence` path in capability discovery. Absence is
pending. Presence requires JSON plus `--name` and `--bundle`; incompatible flags
or schema fail until reconciled with the candidate's source and CLI tests.

The helper creates a real `repros/verify-fixture/repro.json` and Compose document
using the persisted snake_case format in `src/core/runner/record.ts`. The record
contains synthetic URL userinfo, path, query, and an admin password; Compose has
a synthetic `ADMIN_PASS`, reused in a command, neutral label value and mapping key.
Seed metadata includes allowed counts and secret-bearing unknown fields. No workspace
is started.

Drive `bin/houston evidence --name verify-fixture --json`, then repeat with
`--bundle <evidence-directory>/bundle --json`. Require successful
`houston.evidence.v1` envelopes at contract 2, origin-only
`http://127.0.0.1:39999`, no top-level login or environment sections. Require bundle
`manifest.json`, `README.md` and the sanitized `docker-compose.yml`, with the expected
workspace name. Require `manifest.artifact.sha256` to match the original Compose
bytes. Require `manifest.artifact.sanitized.name` to name the attachment and its
`sha256` to match the attached bytes. The raw and sanitized hashes must differ for
this secret-bearing fixture.

Require the exact seed projection `{profile, planned.users, actual.users}` in
the JSON response, bundle response, and manifest. Require the bundle response to
list exactly `README.md`, `docker-compose.yml`, and `manifest.json`; each must be
a self-contained regular file. The bundle root must be a real directory, never
a symlink, and must remain a real directory after scratch cleanup. Compare the manifest projection with the bundle
response and fixture. The README must identify the fixture, and the parsed Compose
attachment must preserve the Rocket.Chat service while masking its synthetic
credentials. The shared command-receipt check scans every stdout and stderr file,
including both evidence commands; this recipe also scans every bundle file for the
synthetic sentinel and fails on any occurrence. Raw artifact copying that leaks the
sentinel is a product failure.

Keep stdout, stderr, bundle files, exit receipts, and hashes after scratch
cleanup. Record the before/after topology manifest for the synthetic workspace
and the full candidate fingerprint on both passing and failing runs. Re-read every
retained bundle attachment after cleanup. This proves the CLI's offline projection
and attachable artifact handling only. The restricted PATH makes engine tools
unavailable, so real service state, engine versions, container/pod log redaction,
Kubernetes bundles, and teardown receipts remain pending live-runtime
prerequisites. Never substitute invented engine output.
