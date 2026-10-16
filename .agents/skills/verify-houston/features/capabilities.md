# Discovery and missing workspace

Reach discovery with `bin/houston capabilities`, without `--json`. The helper
captures the real command's stdout, stderr, and exit code. Require exit 0, one
`houston.capabilities.v1` envelope, contract 2, `ok: true`, and the package version
in both envelope and data. Require the advertised `info` JSON contract and
`--name` flag, and the default bind host `127.0.0.1`. Before using a driven
descriptor, require literal `json: true` and a string array of flags, then check
required flag membership and the exact schema. This applies to discovery, info,
inspect, evidence, capture, onboarding, its setup flags, and guarded down probes.
A truthy string, substring match, or mixed-type flags array must fail. Optional
commands remain pending only when absent.

Reach the important failure with
`bin/houston info --name verify-missing --json` in the isolated home. Require exit
4, one `houston.error.v1` envelope with contract 2, `ok: false`, and error code
`NOT_FOUND`. The home contains a different synthetic workspace, so failure also
checks that an explicit unknown name is not replaced with an existing workspace.

Prerequisites are installed dependencies and the source checkout. The helper
compares `bin/houston --version` with `package.json` first. Receipts are
`version.*`, `capabilities.*`, `missing-workspace.*`, and `commands.json`. These
commands establish parser and failure behavior without an engine or live server.
The shared receipt check scans both streams for these commands, including the
missing-workspace refusal, before their envelopes are accepted.
