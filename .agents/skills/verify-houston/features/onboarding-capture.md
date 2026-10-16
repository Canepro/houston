# Onboarding and capture

When `onboard` is advertised, require `json: true` and schema
`houston.onboard.v1` in capabilities before driving it. The helper creates synthetic legacy configuration
inside its disposable home. It runs `onboard --json`, refuses an unknown grant
without changing that file, then drives `onboard grant owned-cluster --json`
and `onboard revoke owned-cluster --json`. A separate status process must read
the grant back. The persisted YAML must retain unrelated preferences, selectors,
explicit denials and unknown fields. Granting adds only `houston-local` to the
existing cluster scopes; revoking removes only that entry. The completion stamp
must survive revocation and the version must match the running package.

These commands answer questions only in the verifier's temporary home. They
never grant permission in the operator's real home. The helper then drives
`down --name verify-owned-kube-fixture --yes --json` with missing onboarding and
with a denied owned-cluster grant. It requires exit 6, the exact gate code and
the next-action command. A disposable executable trap satisfies kubectl discovery;
its marker must remain absent, proving the refusal happened before invoking
any cluster client. The recorded workspace and configuration must remain unchanged
by each refusal. No real engine or cluster operation runs. Create, orphan-prune
and granted live-engine behavior remain outside this helper. Goal-first setup has a separate [recipe](setup.md).

Capture's draft contract is `capture --name NAME --workload smoke --bundle PATH
--json`, schema `houston.capture.v1`. Read `src/core/capture.ts` and
`test/cli/capture-commands.test.ts` on the candidate. When capabilities advertise
that contract, the helper drives an explicit missing workspace and requires exit
4, error code `NOT_FOUND`, no bundle directory and unchanged fixture bytes. This
refusal occurs before browser startup. The helper injects a scratch-only Node
preload that resolves `playwright` and `playwright-core` to a fake Chromium whose
launch writes a marker. The marker must remain absent. A successful capture
claim needs a supported browser, an explicitly approved synthetic target, and a
retained nonempty capture artifact that can be opened after cleanup. Record the
exact target and prerequisite versions. If it starts a temporary listener, bind
to loopback and verify the actual bind before driving it; stop only its owned PID.

The baseline starts no browser, workspace, listener, or infrastructure. Real
login, browser capture and artifact content remain pending. Onboarding writes
only disposable synthetic configuration. Extend the successful browser recipe against the final candidate and
retain its artifacts. A missing-workspace refusal does not establish a
successful capture.
