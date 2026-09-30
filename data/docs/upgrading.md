# Updating and upgrading

**Contents:** [Updating houston](#updating-houston) ·
[Replacing an older install](#replacing-an-older-install) ·
[From houston 1.x](#from-houston-1x) · [From rc-repro](#from-rc-repro)

---

## Updating houston

```bash
npm update -g @klovekesh37/houston
houston --version
```

From a clone, `git pull && yarn install --immutable` is the whole update: `bin/houston`
runs the source directly, so there is nothing to build.

---

## Replacing an older install

houston 1.x and rc-repro, houston's earlier name, were installed with pipx. An npm
install does not replace a pipx command, so whichever `houston` comes first on your
`PATH` runs. houston 1.x keeps working after 2.x is installed, so there is no hurry.
To make 2.x the one that runs, remove the old command and install 2.x:

```bash
pipx uninstall rc-repro     # if you had rc-repro
pipx uninstall houston      # if you had houston 1.x
npm install -g @klovekesh37/houston
houston --version
```

Then run any houston command once. It takes over your existing state by itself, as the
next two sections describe.

---

## From houston 1.x

houston 2.x replaces 1.x. **Every command, flag, exit code and `--json` format is the
one you already use**, and it reads the same `~/.houston`. Some messages are worded
differently: they name the file and the reason in plain words. Scripts should branch on
the exit code and `error.code`, as [Scripts and agents](automation.md) says.

**A home houston 1.0.0 wrote** has no marker in `~/.houston/IMPLEMENTATION`: 1.0.0 does
not write one. The first 2.x command claims the home for 2.x, prints nothing about it,
and changes nothing else. 1.0.0 does not read the marker either, so it keeps working on
the same home.

**A home a 1.x build marked** is adopted on the first command, once:

1. houston sees 1.x's own marker in `~/.houston/IMPLEMENTATION`.
2. It reads back every state file under every lock: `config.yaml`, accounts, sessions,
   the audit log, workspace records, backups and its bookkeeping.
3. When all of them read, it marks the directory `dual-v1` and prints one note on
   stderr, starting `note: <your home> was last written by houston 1.x.`

Nothing else is rewritten, no workspace is touched, and the note does not appear again.
If anything does not read back, the command stops and says what, and the directory is
left exactly as it was.

**Stop every `houston serve` first**, the 1.x one included. Adoption refuses while one
runs, because a running GUI holds state the check cannot see.

**1.x keeps working beside 2.x.** After adoption, 1.x reads the `dual-v1` directory too,
both take the same locks, and every state file is written the way 1.x writes it. A 1.x
`serve` unit or script on the same machine carries on unchanged.

**If adoption was interrupted,** `~/.houston/IMPLEMENTATION.transition` is left behind
and every command refuses with exit 3 until it is dealt with. The refusal says how: if
no houston is running, remove that file. The marker was not changed, so the next command
simply adopts the directory again.

This adoption stays for as long as 1.x installs are supported. A release that drops it
will say so in its release notes first.

---

## From rc-repro

houston used to be called **rc-repro**. No package manager upgrades across a rename,
so uninstall rc-repro as shown above. **Everything else moves by itself on the first
houston command**, with nothing to tear down first:

| What | What happens |
|---|---|
| `~/.rc-repro` | moved to `~/.houston` |
| your workspaces | adopted, not recreated: their containers, volumes, namespaces and URLs are kept |
| the shared HTTPS edge | restarted under its new name, on ports 80 and 443 again, with your Let's Encrypt account intact |
| your local CA | reused, so the certificate already in your system trust store keeps working |
| agent skills | the old `rc-repro` skill copies are replaced |
| `RC_REPRO_*` variables | still read as old spellings of `HOUSTON_*`, with a warning |
| `seed --clear-scale` | still removes rows seeded before the rename |

`--json` output is contract 2. The old `rc_repro_version` field and the old schema
names are gone.

**One step is left to you:** a `rc-repro.service` systemd unit, if you made one. Removing
it needs `sudo`, so `houston doctor` prints the command instead of running it.
