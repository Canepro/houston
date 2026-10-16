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
a self-contained regular file. The reported bundle path must be absolute, usable
as a directory at the response boundary and resolve strictly to the requested
bundle. A usable absolute symlink alias to that same directory is supported;
relative paths, wrong destinations, missing intermediate components and
regular-file traversal are refused. No cwd-based path expansion is accepted.
The bundle root must be a real directory, never
a symlink, and must remain a real directory after scratch cleanup. Compare the manifest projection with the bundle
response and fixture. The README must identify the fixture, and the parsed Compose
attachment must preserve the Rocket.Chat service while masking its synthetic
credentials. The shared command-receipt check scans every stdout and stderr file,
including both evidence commands; this recipe also scans every bundle file for the
synthetic sentinel and fails on any occurrence. Raw artifact copying that leaks the
sentinel is a product failure. The manifest, README and parsed Compose input
each have a 1 MiB descriptor read cap; oversized candidate output fails before
parsing. Hash and sentinel scans remain chunked independently of that cap.
The shared [file work limits](../SKILL.md#cleanup) also cap each scanned or hashed
file, aggregate bytes, traversal work and elapsed time, including final inventory
readback. Exhaustion is a failed, incomplete check with cleanup and failure facts.

Command stdout and stderr must also match the expected digests retained at
emission, including empty streams and failed commands. Use the printed summary
and its `inventory` field to select the authoritative hash manifest.

Keep stdout, stderr, bundle files, exit receipts, and hashes after scratch
cleanup. Record the before/after topology manifest for the synthetic workspace
and the full candidate fingerprint on both passing and failing runs. Re-read every
retained bundle attachment after cleanup. This proves the CLI's offline projection
and attachable artifact handling only. The restricted PATH makes engine tools
unavailable, so real service state, engine versions, container/pod log redaction,
Kubernetes bundles, and teardown receipts remain pending live-runtime
prerequisites. Never substitute invented engine output.

Decoded JSON envelopes, bundle manifests and YAML projections must reject the
synthetic sentinel in every string key and value, including nested sequences.
Keep the raw byte scan too. The offline regression uses escaped Unicode in the
JSON subset of YAML and a synthetic `JSON.parse` YAML adapter. It exercises the
verifier's decoded-document acceptance, not the dependency-backed YAML parser.

Check every retained relative path before writing the verdict and final hash
inventory, including empty directories. Inspect readable refused receipt
directories too. Unreadable receipt directories already force failure and remain
excluded from the inventory under the existing refusal contract. A sentinel-bearing
name must fail without an inventory. Diagnostics and failure summaries must redact
the sentinel, including errors from cleanup.
Safe Unicode and punctuation in ordinary names remain supported.
