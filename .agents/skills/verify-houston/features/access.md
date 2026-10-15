# SSH access handoff

Access means instructions for reaching a loopback-bound workspace from the
operator's browser. Its historical owner is `rc_repro/services/access.py`, consumed
as `access.handoff(meta.host_port, meta.root_url)` in the lifecycle payload at
integration commit `ea07050063370437984c40d604bf4c4a9e4eeb40`. Read those files with
`git show` when the legacy copy is absent. This feature does not manage accounts
or authorization grants and does not imply a standalone `access` command.

The legacy result has `mode`, `bind`, `host_port`, `local_port`, `browser_url`,
`tunnel_command`, and `note`. A local session gets direct browser access and no
tunnel command. SSH detection uses SSH_CONNECTION, SSH_CLIENT, or SSH_TTY. Remote
handoff prints an `ssh -N -L` suggestion and a client-side loopback browser URL;
it leaves the workspace bind unchanged and never executes SSH. The recorded root
URL selects IPv4 or IPv6 loopback as the forward target. A remote process cannot
measure a port conflict on the operator's laptop.

Pending the TypeScript consumer and environment contract. Applicability comes
from that consumer's actual payload field or documented CLI output, not a guessed
command name. Inspect its handler and tests after the owner ports it. Extend the
helper's real CLI drive at that point, using only synthetic SSH_CONNECTION and
the port's documented host/user/local-port overrides in the child's environment.
Legacy RC_REPRO_SSH_* spellings describe the old implementation, not assumed v2
flags or environment names.

Drive a local handoff, an SSH handoff, an alternate local port, an invalid port,
and an IPv6 forward target. Require the documented mode, ports, safely quoted
SSH destination, matching loopback browser URL, and the specified invalid-port
refusal. Compare fixture bytes and bind before/after. Capture only synthetic
handoff output; `info --json` can include credentials and is unsuitable for a real
customer attachment. Execute no printed tunnel or account mutation.

Live reachability remains pending an approved SSH destination, existing workspace,
and operator-side browser and available local port. A generated command proves
instructions only. It does not prove a tunnel connects or a browser reaches it.
