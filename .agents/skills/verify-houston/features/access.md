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

The v2 consumer is `info --json`, schema `houston.info.v1`, at `data.access`.
Human `info` prints the same tunnel and browser URL. The helper detects this
payload field and drives local and remote results through the real CLI. It uses
only synthetic SSH_CONNECTION, HOUSTON_SSH_HOST, HOUSTON_SSH_USER, and
HOUSTON_SSH_LOCAL_PORT values. An absent access field leaves this port pending.

Require local mode with no tunnel, remote mode with matching ports and browser
URL, an alternate local port, IPv6 remote loopback, and exit 2 with
VALIDATION_FAILED for an invalid port. Parse the generated command with shell
word rules. Its forwarding argument must explicitly bind the client to
127.0.0.1, and `--` must precede a single destination argument, including spaces,
quotes, shell punctuation, or an option-shaped user override. These explicit
bind and option protections are safety corrections to the historical command.
A wildcard-bound fixture must return null access guidance. Human output must
contain the JSON tunnel and browser URL. Compare fixture bytes before and after.
Execute no printed tunnel or account mutation.

Capture only synthetic handoff output. `info --json` can include credentials
and is unsuitable for a real customer attachment.

Live reachability remains pending an approved SSH destination, existing workspace,
and operator-side browser and available local port. A generated command proves
instructions only. It does not prove a tunnel connects or a browser reaches it.
