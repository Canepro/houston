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

From a clone: `git pull`, then `corepack enable && yarn install --immutable`. There is
nothing to build.

## Replacing an older install

houston 1.x and rc-repro were installed with pipx, which npm does not replace. Remove
the old command, install 2.x, and stop every running `houston serve` (1.x included):

```bash
pipx uninstall rc-repro     # if you had rc-repro
pipx uninstall houston      # if you had houston 1.x
npm install -g @klovekesh37/houston
houston doctor              # the first command takes over your existing state
```

## From houston 1.x

Every command, flag, exit code and `--json` format is the one you already use, on the
same `~/.houston`. Scripts should branch on the exit code and `error.code` (see
[Scripts and agents](automation.md)).

- **A home 1.0.0 wrote** (no `~/.houston/IMPLEMENTATION`) is claimed by the first 2.x
  command, silently.
- **A home a later 1.x marked** is adopted once: houston reads back every state file and
  prints one note, `note: <your home> was last written by houston 1.x.` Nothing else
  changes. 1.x keeps working beside 2.x on that home.
- **If it stops with exit 3** because `~/.houston/IMPLEMENTATION.transition` exists, and
  no houston is running, delete that file; the next command adopts again.

## From rc-repro

houston used to be called rc-repro. Uninstall it as above; the rest moves by itself on
the first houston command:

| What | What happens |
|---|---|
| `~/.rc-repro` | moved to `~/.houston` |
| your workspaces | adopted, with their containers, volumes, namespaces and URLs |
| the HTTPS edge and your local CA | taken over, so certificates and the trust store keep working |
| `RC_REPRO_*` variables | still read as `HOUSTON_*`, with a warning |

A `rc-repro.service` systemd unit is the one thing left to you. `houston doctor` prints
the commands; then make the new one:

```bash
sudo systemctl disable --now rc-repro && sudo rm /etc/systemd/system/rc-repro.service
houston serve --print-service
```
