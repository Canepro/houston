# Resource inspection

The CLI entry is `inspect`, not `inventory`. The port's owners are
`src/core/kube/inventory.ts`, `src/core/runner/inventory.ts`, and
`src/core/lifecycle/payload.ts`'s `inspection`, with the CLI contract in
`src/cli/spec-data.ts`. Read those files and `test/cli/inspect.test.ts` on the
candidate. They are absent on the pinned baseline. Historical Kubernetes
inventory is in `rc_repro/services/k8s.py` at integration commit
`ea07050063370437984c40d604bf4c4a9e4eeb40`. Fetch the branch first if the object
is absent, then read the exact source:

```bash
git fetch fork codex/mira-workbench-integration
git cat-file -e ea07050063370437984c40d604bf4c4a9e4eeb40^{commit}
git show ea07050063370437984c40d604bf4c4a9e4eeb40:rc_repro/services/k8s.py
```

Applicability is the exact `inspect` capability path. Absence is pending. The
owner draft advertises `--name`, `--json`, and `houston.inspect.v1` at contract 2.
When present, the helper drives:

```bash
bin/houston inspect --name verify-missing --json
bin/houston inspect --name verify-fixture --json
bin/houston inspect --name verify-kube-fixture --json
```

The first must return exit 4 with NOT_FOUND. The fixture reads must return the
named workspace and runtime, an origin-only URL, loopback bind, and both runtime
sections. With engine tools unavailable, nodes/services/pods and
containers/networks/volumes must be empty. The active runtime must also report
nonempty warnings. Kubernetes context and namespace must match the synthetic
record, and unavailable Kind must leave `cluster_exists` null. The synthetic secret, login, and environment must
be absent. Require fixture bytes to remain unchanged. Empty offline arrays prove
only the unavailable-engine projection, never an empty or healthy real cluster.
The helper also drives both fixtures without `--json` and requires each Docker
containers, networks, and volumes panel plus each Kubernetes nodes, Services,
and pods panel to mark its own unreadable state `unknown`, with the synthetic
secret absent from both stdout and stderr.

Live prerequisites remain an approved existing Kubernetes context/namespace and
read-only API access to nodes, Services, and pods. Capture actual node readiness,
roles, addresses and allocatable resources; Service type, external addresses,
ports and NodePorts; and pod state. Docker coverage additionally needs an approved
existing project with known container port bindings and labelled networks/volumes.
Compare CLI rows with read-only engine/API results. No Secret, environment read,
resource creation, deletion, or tunnel execution belongs in this recipe.
