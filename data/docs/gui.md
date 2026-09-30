# The web GUI

`houston serve` puts a browser interface in front of houston. It does everything the
command line does, and it is how a team shares one machine: everyone signs in with a
named account, and every action is recorded against it.

**Contents:** [Start it](#start-it) · [The first account](#the-first-account) ·
[Accounts and roles](#accounts-and-roles) · [Clusters](#clusters) ·
[Policies and the audit log](#policies-and-the-audit-log) ·
[Reaching it from another machine](#reaching-it-from-another-machine) ·
[Keeping it running](#keeping-it-running)

---

## Start it

```bash
houston serve                  # http://localhost:7070/
houston serve --port 7171      # another port
```

Nothing extra needs installing. It listens on `127.0.0.1` only: the GUI can create and
delete workspaces and mint admin tokens, so reaching its port is as good as controlling
Docker on this machine. Listening anywhere else takes a deliberate flag; see
[Reaching it from another machine](#reaching-it-from-another-machine).

---

## The first account

With no accounts yet, `serve` prints a one-time setup link:

```
http://localhost:7070/setup#k=Xf9…
```

Open the **whole** link, including the part after `#`. That part never reaches the
server, so the key cannot end up in a log. The page creates the first **admin**
account.

- Each `serve` makes a new setup key, so an older link stops working.
- The setup link only works while `serve` listens on this machine alone. Create the
  first account first, then open it up.
- Prefer the terminal? Run `houston users add <name>` before `serve`, and `serve` shows
  a normal sign-in page.

---

## Accounts and roles

```bash
houston users                     # who exists, their roles and dates
houston users add alice           # generates a password and prints it once
houston users add alice --ask-password
houston users role alice admin    # admin, member or readonly
houston users passwd alice        # a new password; ends alice's sessions
houston users remove alice        # and every session alice had
```

| Role | May |
|---|---|
| `admin` | everything, including managing accounts |
| `member` | everyday work: create, seed, load-test, tear down |
| `readonly` | look but not change. It also cannot read logs or environment variables, which can hold LDAP bind passwords and OAuth secrets |

- The first account is an admin. Every account after it is a `member` until you change
  it.
- Generated passwords are long and random. `--ask-password` lets you type one of at
  least 12 characters.
- Sign-outs and password changes take effect at once: sessions are kept on the server,
  so ending one really ends it.
- Account names become part of workspace names, so they are folded to lowercase letters,
  digits and dashes. `lucy.felix` and `Lucy_Felix` are both `lucy-felix`, and `users
  add` prints the name it made.

**Roles apply to the web GUI only.** Anyone with a shell on the machine can run houston
directly, so a `readonly` account limits what someone can do through the browser, not
over SSH.

---

## Clusters

The top bar has a **Clusters** link. Once houston knows of a cloud cluster, a chip
beside it shows what the clusters are costing, and turns amber when one needs
attention.

The Clusters view shows a card per cluster with what it holds and what it costs,
checks every AWS region for clusters you may have forgotten, and copies out the
permission documents. Anyone who can sign in may look at it. Creating and deleting a
cluster needs an admin, and deleting one asks you to type its name.

A card showing `?` has not been read yet, or could not be. `?` never means zero.

---

## Policies and the audit log

```bash
houston config set gui.create_policy admin      # only admins may set --rc-image, --reg-token or --bind
houston config set gui.destroy_policy anyone    # members may delete anyone's workspace
houston config set bind_host 0.0.0.0            # one decision for every new workspace
houston audit                                   # who did what
houston chown --name <workspace> --to bob       # hand a workspace to someone else
```

Every action is written to `~/.houston/audit.log` with the account that took it. With
accounts, names houston makes up for workspaces start with the owner's name, so two
people can run the same version side by side.

In the GUI the account is whoever signed in. On the command line houston takes it from
`HOUSTON_USER` when that is set, and otherwise from your login name when an account has
that name; with neither, the action is recorded as houston's own. Names count only once
accounts exist. `HOUSTON_USER` is a claim, not a sign-in: anyone with a shell can set it,
so `houston audit` marks those lines `asserted` rather than `session`.

---

## Reaching it from another machine

Signing in over plain HTTP sends the password across the network, and the session
cookie with every request after it. So `serve` refuses to listen on a reachable address
over plain HTTP unless you say what protects it. Pick the row that matches where HTTPS
ends:

| Where HTTPS ends | Command |
|---|---|
| nowhere: only you, on this machine | `houston serve` |
| houston handles it, on a name that points here | `houston serve --domain rc.example.com --email you@example.com` |
| a proxy on this machine | `houston serve --bind 127.0.0.1 --allow-host rc.example.com` |
| a proxy somewhere else (a lab, Codespaces, ngrok, a load balancer) | `houston serve --bind 0.0.0.0 --allow-host rc.example.com --trust-proxy 10.0.0.1` |

- **`--allow-host`** names the host people will type in the address bar. A request for
  any other host gets a 403, which protects against DNS rebinding. You can repeat it,
  and `*` accepts any host.
- **`--trust-proxy <address or CIDR>`** lets houston believe that proxy when it says the
  connection was HTTPS. Without it the session cookie cannot be marked secure. A bare
  `0.0.0.0` means only the address `0.0.0.0`, which no proxy has; write `0.0.0.0/0` for
  any address, or better, the proxy's real address.
- If nothing protects it and you accept that, `serve` names the flag to use at the
  moment it refuses.

---

## Keeping it running

```bash
houston serve --domain rc.example.com --email you@example.com --print-service
```

`--print-service` prints a systemd unit and how to install it, plus a `nohup`
alternative, and changes nothing, so you can read it first. The unit runs the `houston`
you ran, so it keeps working after you update houston.
