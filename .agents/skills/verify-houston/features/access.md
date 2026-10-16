# SSH access handoff

Access means instructions for reaching a loopback-bound workspace from the
operator's browser. Its historical owner is `rc_repro/services/access.py`, consumed
as `access.handoff(meta.host_port, meta.root_url)` in the lifecycle payload at
integration commit `ea07050063370437984c40d604bf4c4a9e4eeb40`. Read those files with
`git show` when the legacy copy is absent. Fetch the named source first when the
object is not local:

```bash
git fetch fork codex/mira-workbench-integration
git cat-file -e ea07050063370437984c40d604bf4c4a9e4eeb40^{commit}
git show ea07050063370437984c40d604bf4c4a9e4eeb40:rc_repro/services/access.py
```

The same commit exposes `rc_repro/services/k8s.py`. This feature does not manage
accounts or authorization grants and does not imply a standalone `access` command.

The legacy result has `mode`, `bind`, `host_port`, `local_port`, `browser_url`,
`tunnel_command`, and `note`. A local session gets direct browser access and no
tunnel command. SSH detection uses SSH_CONNECTION, SSH_CLIENT, or SSH_TTY. Remote
handoff prints an `ssh -N -L` suggestion and a client-side loopback browser URL;
it leaves the workspace bind unchanged and never executes SSH. The recorded root
URL selects IPv4 or IPv6 loopback as the forward target. A remote process cannot
measure a port conflict on the operator's laptop.

The v2 consumer is `info --json`, schema `houston.info.v1`, at `data.access`.
Human `info` prints a workspace panel title and the same tunnel and browser URL.
A remote handoff `note` must be nonempty text; a boolean, number, object or
whitespace-only string is not guidance. The helper probes the clean
Docker fixture `verify-docker-access-fixture` and the Kubernetes fixture
`verify-access-fixture`. Each payload `data` value must be an object, or the run fails. When both objects omit `data.access`, this port stays
pending. When either object has `data.access`, require the local, human, and
SSH contract on both loopback runtimes. Require `data.name` and `data.runtime`
to match each requested fixture before accepting its access values. These are
existing fields from `lifecycle/payload.detail` through `lifecycle/inspect.summary`,
not fields added to the `access` object. Check them again on every successful SSH
JSON response, the IPv6 response, and both local-session and SSH-session wildcard
responses. Identical access
values cannot establish that both runtimes were exercised. It uses only synthetic SSH_CONNECTION,
SSH_CLIENT, SSH_TTY, HOUSTON_SSH_HOST, HOUSTON_SSH_USER, and
HOUSTON_SSH_LOCAL_PORT values.

Require local mode with no tunnel and human output containing the local browser
URL. On every local and remote human process require the exact first panel title
to match the requested fixture. The real `summaryPanel` renderer has no Runtime
row. Docker uses port 39998 and Kubernetes uses 39999, so the actual human URL and
tunnel guidance also distinguish the runtime. Keep JSON identity and guidance
checks independent of the human process. Exercise SSH_CONNECTION, SSH_CLIENT, and SSH_TTY separately. Remote mode
must carry matching ports and browser URL, an alternate local port, accepted port
1024, IPv6 remote loopback, and exit 2 with VALIDATION_FAILED for nonnumeric,
-1, 1023, and 65536 local ports. Parse the generated command with shell word
rules. It must include `-o ExitOnForwardFailure=yes`; its forwarding argument
must explicitly bind the client to 127.0.0.1. The IPv6 fixture also requires
one forward for each recorded sidecar and monitoring port. A primary local port
that collides with either sidecar forward or the monitoring forward must refuse
with exit 2 and VALIDATION_FAILED. Drive 4312, 4313, and 4314 independently,
keeping the non-colliding IPv6 forward receipt as the nearby success control.
Also require successful SSH JSON and human guidance for each of those same local
ports on `verify-access-fixture`, which has no recorded side ports. A global ban
on these numbers must fail verification. These successes use the same workspace
identity, loopback bind, complete tunnel and browser URL checks as other SSH
responses.
The `--` delimiter must precede a single
destination argument, including spaces, quotes, shell punctuation, or an
option-shaped user override. These explicit bind and option protections are
safety corrections to the historical command.
A wildcard-bound fixture must return null access guidance both without SSH markers
and with a synthetic SSH marker. Check its workspace name and runtime on each
response. Human output must
contain the JSON tunnel and browser URL. Compare fixture bytes before and after.
Execute no printed tunnel or account mutation.

Capture only synthetic handoff output. `info --json` can include credentials
and is unsuitable for a real customer attachment.

Live reachability remains pending an approved SSH destination, existing workspace,
and operator-side browser and available local port. A generated command proves
instructions only. It does not prove a tunnel connects or a browser reaches it.

The three IPv6 side-port collision probes inherit the successful IPv6 SSH session,
user and host settings and vary only the local primary port. Require
`VALIDATION_FAILED` and a message naming `HOUSTON_SSH_LOCAL_PORT`, that port and
`side ports`, matching the owner refusal. A missing-SSH-settings rejection does
not establish collision detection.
