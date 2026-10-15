# Attachable evidence

Applicability is the exact `evidence` path in capability discovery. Absence is
pending. Presence requires JSON plus `--name` and `--bundle`; incompatible flags
or schema fail until reconciled with the candidate's source and CLI tests.

The helper creates a real `repros/verify-fixture/repro.json` and Compose document
using the persisted snake_case format in `src/core/runner/record.ts`. The record
contains synthetic URL userinfo, path, query, and an admin password; Compose has
a synthetic `ADMIN_PASS`. No workspace is started.

Drive `bin/houston evidence --name verify-fixture --json`, then repeat with
`--bundle <evidence-directory>/bundle --json`. Require successful
`houston.evidence.v1` envelopes at contract 2, origin-only
`http://127.0.0.1:39999`, no top-level login or environment sections. Require bundle
`manifest.json` and `README.md`, with the expected workspace name. The deployment attachment name
and any hash fields follow the evidence owner's final sanitized-bundle contract;
a raw source digest and a sanitized attachment digest can legitimately differ. Until that contract is read and its attachment checks
are added, bundle completeness remains pending even when the current probes
succeed. Scan JSON and every bundle file for the synthetic secret and fail on any occurrence. Raw artifact
copying that leaks the sentinel is a product failure, not a verifier exemption.

Keep stdout, stderr, bundle files, exit receipts, and hashes after scratch
cleanup. Check the synthetic workspace bytes remain unchanged. This proves the
CLI's offline projection and attachable artifact handling only. The restricted
PATH makes engine tools unavailable, so real service state, engine versions,
container/pod log redaction, Kubernetes bundles, and teardown receipts remain
pending live-runtime prerequisites. Never substitute invented engine output.
