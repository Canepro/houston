"""Durable notes about side effects that must be undone, so a killed process does
not leave them behind.

WHY A FILE AND NOT A `finally`. The GUI runs long operations on daemon threads, so
`systemctl restart`, an OOM kill or a plain SIGKILL ends them where they stand and
skips every `finally` they were relying on. Those blocks are doing real work:
`backup` stops Rocket.Chat for the duration of the dump, `loadtest` turns the API
rate limiter OFF, `capacity` arms the Mongo profiler and applies container CPU/RAM
caps, and `benchmark` (deleted in step 0.12) created throwaway workspaces it meant
to delete. Interrupted, all
of that outlives the process -- a workspace that silently is not serving, a rate
limiter left off, ten pods still running -- with nothing anywhere recording that it
happened. `web/jobs.py` keeps its registry in memory, so a restart loses even the
knowledge that a job existed.

Cooperative cancellation cannot fix this. It helps a graceful shutdown, which the
25-second drain in `jobs.drain` already mostly covers; the dangerous exit is the one
where no Python runs at all. What survives that is a note written BEFORE the risky
change and removed AFTER it is undone.

THE HARD PART IS NOT WRITING IT, IT IS KNOWING WHOSE IT IS. An open entry belongs
either to a job still running or to a process that died. Repairing the first would
re-enable the rate limiter underneath a load test that is still going. So each entry
records the pid AND that process's start time, and recovery touches an entry only
when its owner is provably gone -- pid alone is not enough, because the OS recycles
them (the same mistake `forward_alive` was making about port-forwards).
"""

from __future__ import annotations

import json
import os
import secrets
import time
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path

from houston import config, runner
from houston.services.events import Emit, info, null_emit, warn

#: One file per open side effect. A directory rather than a single log because
#: entries are created and cleared concurrently by unrelated jobs, and an unlink is
#: atomic where a rewrite of a shared file is a lost-update race.
DIRNAME = "journal"

#: Kinds, closed on purpose: recovery has to know how to undo each one, so a kind
#: nothing can repair is a note that would sit there forever looking like a fault.
RATE_LIMITER_OFF = "rate_limiter_off"
ROCKETCHAT_STOPPED = "rocketchat_stopped"
#: A throwaway workspace the deleted `benchmark` command meant to delete. The most
#: expensive of these to leave behind: one Rocket.Chat plus one MongoDB per version
#: under test.
#:
#: NOTHING RECORDS THIS ANY MORE and it stays anyway. `benchmark` went in step 0.12,
#: but a journal note is durable state on somebody's disk, and the entire purpose of
#: this module is that a killed process's side effects are recoverable LATER -- by a
#: build that may be newer than the one that made the mess. Dropping the kind from a
#: closed vocabulary would strand exactly the notes it exists to honour: `_load` would
#: read the entry, `_SUBJECT_EXISTS` would not know how to ask about it and `describe`
#: would have nothing to say, so a leftover Rocket.Chat and MongoDB would sit there
#: undescribed. Remove it when no home can plausibly still hold one, not before.
BENCH_WORKSPACE = "bench_workspace"
#: Container CPU/RAM caps a performance run applied, with the PRIOR values so restore
#: puts back what was there rather than guessing at "unlimited".
CONSTRAINTS_APPLIED = "constraints_applied"
#: A create that never reached the end. ADVISORY -- see `ADVISORY` below.
CREATE_UNFINISHED = "create_unfinished"
#: Rocket.Chat's Prometheus metrics endpoint, turned on for a `--diag` run. Restored in
#: a `finally`, which is exactly the block a SIGKILL does not run.
RC_METRICS_ON = "rc_metrics_on"
#: Mongo's query profiler, armed at the caller's `slowms` for a `--diag` run. Carries
#: the PRIOR level, because `mongoprof.stop` restores to a value rather than to off --
#: a workspace that already had profiling on must keep it.
#:
#: The worse of the two to leave behind: level 1 writes a system.profile document for
#: every operation over slowms, for the life of the workspace, which is a permanent
#: write amplification on somebody's reproduction that then LOOKS like a Rocket.Chat
#: performance problem.
MONGO_PROFILER_ON = "mongo_profiler_on"
#: Email-2FA turned off for the duration of a seed. Seeded users have no mailbox on a
#: repro, so seeding disables this to make them loginable and restores it in a `finally`
#: -- the block a SIGKILL does not run. A `large` seed is minutes long and `jobs.drain`
#: gives it 25s, so a `systemctl restart` mid-seed is routine rather than exotic; what
#: survives is a workspace whose 2FA posture silently differs from the one an engineer
#: is about to measure.
EMAIL_2FA_OFF = "email_2fa_off"
#: The database was DROPPED and the archive had not finished loading. ADVISORY: recovery
#: cannot safely re-run a mongorestore at `serve` startup -- it would be minutes of work
#: on a workspace nobody asked about, and re-running it against a partially loaded
#: database is not obviously better than leaving it. So it is reported and left, and
#: `doctor`'s `interrupted-work` row picks it up for free.
#:
#: The window is real: `--drop` is not enough on its own (a collection absent from the
#: bundle would survive), so the restore drops the database FIRST -- and a multi-GB
#: bundle then takes minutes. A SIGKILL in there restarts Rocket.Chat against an empty
#: database, and `_Quiesced`'s own note makes recovery restart it, so `serve` reports the
#: workspace repaired. README promises "the target database is dropped first, so you
#: never get a hybrid" -- true, and it swapped in a worse failure that nothing recorded.
DATABASE_DROPPED = "database_dropped"
#: An `eksctl create cluster` that was started and never seen to return.
#:
#: ADVISORY, and recovery must NEVER act on it. Deleting a cloud cluster is minutes
#: of destructive work on somebody's AWS account, and a process that already crashed
#: once is not the thing that should decide to do it. So this note is REPORTED, loudly,
#: with the exact commands to run -- and its `workspace` field carries the CLUSTER
#: name, which is precisely why `still_there` had to stop meaning `runner.exists`.
CLUSTER_UNFINISHED = "cluster_unfinished"
KINDS = (RATE_LIMITER_OFF, ROCKETCHAT_STOPPED, BENCH_WORKSPACE,
         CONSTRAINTS_APPLIED, CREATE_UNFINISHED, RC_METRICS_ON, MONGO_PROFILER_ON,
         EMAIL_2FA_OFF, DATABASE_DROPPED, CLUSTER_UNFINISHED)
#: The setting EMAIL_2FA_OFF is about, named once so the seed path and the repair cannot
#: disagree about which key they mean.
EMAIL_2FA_SETTING = "Accounts_TwoFactorAuthentication_By_Email_Enabled"

#: Kinds recovery REPORTS but does not undo by itself.
#:
#: `CREATE_UNFINISHED` is the whole set, and the reason is a timing one: finishing a
#: create means waiting for Rocket.Chat to serve and then running the preset's
#: self-configuration, which can take the full readiness timeout. Doing that inside
#: `serve`'s startup would hold the GUI shut for minutes on a workspace nobody asked
#: about yet. `houston ready --name <it>` is the same work on demand, and it clears
#: the note when it succeeds -- so this is a note that closes itself once acted on,
#: not one that sits there forever.
ADVISORY = (CREATE_UNFINISHED, DATABASE_DROPPED, CLUSTER_UNFINISHED)

#: Kinds whose note is ABOUT A WORKSPACE, and so goes when that workspace's record does.
#:
#: `down --volumes` and `prune` delete the containers, the data and the record, and
#: nothing cleared the notes about them: only a create that finishes and `ready` ever
#: closed a `CREATE_UNFINISHED`, and both need the workspace to exist. Seen as 28 notes
#: for one workspace that `down --volumes` had removed, and `doctor` went on advising
#: `houston ready --name <it>` -- advice that cannot work on a workspace that is gone.
#: `serve`'s recovery drops such notes at its next start, but a CLI-only box never
#: starts one, and `doctor` is what tells that box.
#:
#: Each one, and why it goes with the workspace:
#:   RATE_LIMITER_OFF, EMAIL_2FA_OFF, RC_METRICS_ON, MONGO_PROFILER_ON -- a setting held
#:       in the workspace's database, which the deletion took with its volume.
#:   ROCKETCHAT_STOPPED, CONSTRAINTS_APPLIED -- the state of a container, and the
#:       containers are gone.
#:   BENCH_WORKSPACE -- its repair IS deleting the workspace, which has just happened.
#:   CREATE_UNFINISHED -- `ready` completes a workspace; there is none left to complete.
#:   DATABASE_DROPPED -- the half-loaded database went with the volume.
WORKSPACE_KINDS = (RATE_LIMITER_OFF, ROCKETCHAT_STOPPED, BENCH_WORKSPACE,
                   CONSTRAINTS_APPLIED, CREATE_UNFINISHED, RC_METRICS_ON,
                   MONGO_PROFILER_ON, EMAIL_2FA_OFF, DATABASE_DROPPED)
#: The kinds that must OUTLIVE a workspace of the same name, and why.
#:   CLUSTER_UNFINISHED -- its `workspace` field carries a CLUSTER name, and the cluster
#:       may be billing now. A workspace called the same is not that cluster, and
#:       deleting it says nothing about whether an interrupted `eksctl create` left a
#:       VPC and a NAT gateway behind.
#: Every kind is in exactly one of the two, so a new kind has to be decided here rather
#: than fall into whichever default was nearest.
OUTLIVE_THE_WORKSPACE = (CLUSTER_UNFINISHED,)


@dataclass
class Entry:
    id: str
    kind: str
    workspace: str
    pid: int
    started: str = ""          # the owning process's start time, as /proc reports it
    at: str = ""
    detail: dict = field(default_factory=dict)

    @property
    def owner_alive(self) -> bool:
        """Whether the process that wrote this is still running.

        pid AND start time, because a recycled pid is a different process. An
        unknowable start time (no /proc) falls back to pid liveness, which is the
        conservative direction here: it means "assume the owner is alive", so
        recovery leaves the entry alone rather than undoing live work.
        """
        current = proc_started(self.pid)
        if current is None:
            return False
        if not self.started:
            return True
        return current == self.started


def journal_dir() -> Path:
    return config.home() / DIRNAME


def proc_started(pid: int) -> str | None:
    """A process's start time as a stable string, or None if it is not running.

    Field 22 of /proc/<pid>/stat, in clock ticks since boot. Read from the raw
    bytes and split from the RIGHT of the last ')', because field 2 is the
    executable name and may itself contain spaces or brackets.
    """
    try:
        raw = Path(f"/proc/{int(pid)}/stat").read_bytes().decode("utf-8", "replace")
    except (OSError, ValueError, TypeError):
        return None
    try:
        return raw[raw.rindex(")") + 1:].split()[19]
    except (ValueError, IndexError):
        return ""          # running, but the start time could not be read


def record(kind: str, workspace: str, **detail) -> str:
    """Note a side effect that must be undone. Returns the entry id.

    Best-effort by design: a journal that cannot be written must not stop the
    operation it was describing. The operation's own `finally` is still the primary
    cleanup -- this is only what covers the case where no `finally` runs.
    """
    if kind not in KINDS:
        raise ValueError(f"unknown journal kind {kind!r} (want: {', '.join(KINDS)})")
    entry = Entry(id=secrets.token_hex(8), kind=kind, workspace=workspace,
                  pid=os.getpid(), started=proc_started(os.getpid()) or "",
                  # UTC, LIKE EVERY OTHER TIMESTAMP HERE. `time.strftime` with no
                  # argument is LOCAL time, so one event read 22:29 in a journal note
                  # and 16:59 in the repro.json written beside it -- and a note is read
                  # next to `doctor`, `list` and an audit line, all of which are UTC.
                  at=time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
                  detail=dict(detail))
    try:
        d = journal_dir()
        d.mkdir(parents=True, exist_ok=True, mode=0o700)
        runner.atomic_write(d / f"{entry.id}.json", json.dumps(asdict(entry), indent=2))
    except OSError:
        return ""
    return entry.id


def clear(entry_id: str) -> None:
    """Forget an entry, because whatever it described has been undone."""
    if not entry_id:
        return
    try:
        (journal_dir() / f"{entry_id}.json").unlink(missing_ok=True)
    except OSError:
        pass


def clear_kind(kind: str, workspace: str) -> int:
    """Forget EVERY note of one kind for one workspace. Returns how many went.

    Some facts invalidate other processes' notes, not just your own. "This workspace's
    create finished" is one: a create that failed left a `CREATE_UNFINISHED` note
    behind, and a later create of the same name that succeeded cleared only the note it
    had written itself -- so the stale one went on claiming a complete workspace had
    never finished. Seen exactly that way, when a failed attempt was followed by a good
    one.
    """
    gone = 0
    for entry in open_entries():
        if entry.kind == kind and entry.workspace == workspace:
            clear(entry.id)
            gone += 1
    return gone


def clear_workspace(workspace: str, kinds: tuple[str, ...] = WORKSPACE_KINDS) -> int:
    """Forget every note ABOUT one workspace, because its record is being deleted.

    Whoever owns the note, alive or not -- unlike recovery, which touches abandoned ones
    only. A live owner's note describes work on a workspace that is going away, so there
    is nothing left for it to put back. Every caller holds the workspace's
    `repro_lock`, which is where a create writes its note, so no create can have one
    here for a workspace it has not made yet. See `WORKSPACE_KINDS` for which kinds go.
    """
    gone = 0
    for entry in open_entries():
        if entry.kind in kinds and entry.workspace == workspace:
            clear(entry.id)
            gone += 1
    return gone


@contextmanager
def side_effect(kind: str, workspace: str, **detail):
    """Record on the way in, clear on the way out -- however that happens.

    Wraps an existing `finally` rather than replacing it: the note is cleared when
    the normal cleanup has run, so a surviving entry means precisely "the cleanup did
    not happen".
    """
    entry_id = record(kind, workspace, **detail)
    try:
        yield entry_id
    finally:
        clear(entry_id)


def open_entries() -> list[Entry]:
    """Every entry on disk, newest last. Unreadable files are skipped, not raised."""
    out: list[Entry] = []
    try:
        paths = sorted(journal_dir().glob("*.json"))
    except OSError:
        return out
    for path in paths:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            out.append(Entry(id=str(data.get("id") or path.stem),
                             kind=str(data.get("kind") or ""),
                             workspace=str(data.get("workspace") or ""),
                             pid=int(data.get("pid") or 0),
                             started=str(data.get("started") or ""),
                             at=str(data.get("at") or ""),
                             detail=dict(data.get("detail") or {})))
        except (OSError, ValueError, TypeError):
            continue
    return out


#: How to ask "is the thing this note is ABOUT still here", per kind.
#:
#: `recover()` clears an advisory note whose subject is gone, and it used to ask that
#: question as `runner.exists(entry.workspace)`. That is the right question for every
#: kind today, because every one of them is about a workspace -- and it is only
#: ACCIDENTALLY right. An `Entry` is keyed on a workspace name and `runner.exists()`
#: tests for workspace markers under `repros/<name>/`, so a note whose subject is NOT
#: a workspace -- a cluster, say -- would find that False always, and be cleared
#: silently at the next `serve` startup by a branch whose comment correctly explains
#: why it is right for the case it was written for. The most expensive note in the
#: product would be the one guaranteed not to survive.
#:
#: The fix is to keep ONE rule and make the rule true, rather than special-casing a
#: kind out of a rule stated as general -- which is the shape that produced this. A
#: kind whose subject is something else registers how to ask about that thing;
#: everything else keeps the default and behaves exactly as it always has.
_SUBJECT_EXISTS: dict[str, Callable[[Entry], bool]] = {}


def register_subject_predicate(kind: str, predicate: Callable[[Entry], bool]) -> None:
    """Register the owning module's way to ask whether a journal subject exists."""
    current = _SUBJECT_EXISTS.get(kind)
    if current is not None and current is not predicate:
        raise ValueError(f"journal subject predicate already registered for {kind}")
    _SUBJECT_EXISTS[kind] = predicate


def subject_predicate_kinds() -> tuple[str, ...]:
    return tuple(sorted(_SUBJECT_EXISTS))


def still_there(entry: Entry) -> bool:
    """Whether the thing an advisory note is about still exists.

    A predicate that RAISES answers True, and that direction is deliberate: "I could
    not ask" is not "it is gone", and the cost of the two mistakes is not symmetric.
    Keeping a stale note wastes a line of output; dropping a live one loses the only
    record that something is still running -- and for a cloud cluster, still billing.
    """
    ask = _SUBJECT_EXISTS.get(entry.kind)
    if ask is None:
        return runner.exists(entry.workspace)
    try:
        return ask(entry)
    except Exception:  # noqa: BLE001 - see the docstring: unaskable is not gone
        return True


def abandoned() -> list[Entry]:
    """Entries whose owning process is gone -- the ones safe to act on."""
    return [e for e in open_entries() if not e.owner_alive]


def describe(entry: Entry) -> str:
    """One line a human can act on, whether or not recovery can."""
    if entry.kind == RATE_LIMITER_OFF:
        return (f"{entry.workspace!r}: the API rate limiter was turned off for a "
                f"performance run at {entry.at} and never turned back on")
    if entry.kind == ROCKETCHAT_STOPPED:
        return (f"{entry.workspace!r}: Rocket.Chat was stopped for a backup at "
                f"{entry.at} and never started again")
    if entry.kind == BENCH_WORKSPACE:
        return (f"{entry.workspace!r}: a throwaway benchmark workspace from {entry.at} "
                f"is still here, holding a Rocket.Chat and a MongoDB")
    if entry.kind == CONSTRAINTS_APPLIED:
        caps = ", ".join(str(a.get("service") or "?")
                         for a in (entry.detail.get("applied") or [])[:3])
        return (f"{entry.workspace!r}: CPU/RAM limits from a performance run at "
                f"{entry.at} are still applied ({caps or 'unknown services'})")
    if entry.kind == DATABASE_DROPPED:
        return (f"{entry.workspace!r}: a restore from "
                f"{entry.detail.get('bundle') or 'a bundle'} dropped the database at "
                f"{entry.at} and never finished loading it — the workspace is running "
                f"against an EMPTY or partial database. `houston restore "
                f"{entry.detail.get('bundle') or '<bundle>'} --name {entry.workspace}` "
                f"again is what completes it")
    if entry.kind == CLUSTER_UNFINISHED:
        name = entry.workspace
        region = str(entry.detail.get("region") or "<region>")
        account = str(entry.detail.get("account") or "unknown account")
        # CloudFormation-shaped, because the obvious advice is the advice that fails:
        # a rolled-back `eksctl create` can leave its stack behind, and `eksctl delete`
        # then reports that the cluster does not exist while a VPC and a NAT gateway
        # carry on billing.
        return (f"an `eksctl create cluster` for {name!r} in {region} "
                f"(account {account}) was interrupted at {entry.at} and never "
                f"returned. It may have created a VPC, a NAT gateway and a control "
                f"plane, which are BILLING NOW. houston will not delete a cloud "
                f"cluster it did not see finish — that is minutes of destructive work "
                f"on your AWS account decided by a process that already crashed. "
                f"Run `eksctl delete cluster --name {name} --region {region} --wait`; "
                f"if that says the cluster does not exist, the CloudFormation stack "
                f"may have rolled back and SURVIVED, so check `aws cloudformation "
                f"describe-stacks --stack-name eksctl-{name}-cluster --region "
                f"{region}` and delete it directly")
    if entry.kind == EMAIL_2FA_OFF:
        return (f"{entry.workspace!r}: email two-factor authentication was turned off "
                f"for a seed at {entry.at} and never turned back on — seeded users are "
                f"loginable and real ones may not be")
    if entry.kind == RC_METRICS_ON:
        return (f"{entry.workspace!r}: Rocket.Chat's Prometheus metrics endpoint was "
                f"turned on for a diagnostic run at {entry.at} and never turned off")
    if entry.kind == MONGO_PROFILER_ON:
        return (f"{entry.workspace!r}: Mongo's query profiler was armed for a "
                f"diagnostic run at {entry.at} and never disarmed — it is still "
                f"writing a system.profile document for every slow operation")
    if entry.kind == CREATE_UNFINISHED:
        seeded = " and its seed" if entry.detail.get("seed") else ""
        return (f"{entry.workspace!r}: the create started at {entry.at} never "
                f"finished, so it may be running WITHOUT its preset configuration"
                f"{seeded or ' or seed data'} — "
                f"`houston ready --name {entry.workspace}` completes it")
    return f"{entry.workspace!r}: {entry.kind} since {entry.at}"


def recover(emit: Emit = null_emit, *, dry_run: bool = False,
            login: Callable | None = None) -> list[dict]:
    """Undo what abandoned entries describe. Returns one result per entry.

    Never raises: this runs at `serve` startup, and a box that cannot be repaired
    still has to be able to serve. Each result carries `repaired` so a caller can
    say what is still outstanding.
    """
    results: list[dict] = []
    for entry in abandoned():
        row = {"id": entry.id, "kind": entry.kind, "workspace": entry.workspace,
               "what": describe(entry), "repaired": False, "why": ""}
        if entry.kind in ADVISORY and not still_there(entry):
            # The thing the note is about is gone, so an unfinished create is no longer
            # anybody's problem. Advisory notes are never repaired, so without this they
            # would warn forever about something that cannot be acted on.
            #
            # `still_there`, not `runner.exists(entry.workspace)`: see that function for
            # why the two are the same today and must not be assumed to stay so.
            #
            # UNDER dry_run THIS IS A READ. The clear used to sit above the dry_run
            # check, so a dry run over two notes reported one and DELETED the other --
            # and a dry run is the only way to inspect the journal without repairing
            # it, which makes mutating one a contradiction in terms.
            if dry_run:
                row["why"] = "the thing it is about is gone; would be dropped"
                results.append(row)
                continue
            clear(entry.id)
            continue
        if dry_run or entry.kind in ADVISORY:
            # Reported and left alone. See ADVISORY: undoing this one means waiting for
            # a workspace to serve, which is not something a GUI startup may spend.
            row["why"] = ("needs `houston ready`" if entry.kind in ADVISORY else "")
            results.append(row)
            if entry.kind in ADVISORY:
                warn(emit, row["what"], phase="preflight")
            continue
        try:
            row["repaired"] = _repair(entry, emit, login)
        except Exception as exc:  # noqa: BLE001 - recovery must not break startup
            row["why"] = str(exc)
        if row["repaired"]:
            clear(entry.id)
            info(emit, f"repaired: {row['what']}", phase="preflight")
        else:
            warn(emit, f"could NOT repair — {row['what']}"
                       + (f" ({row['why']})" if row["why"] else ""), phase="preflight")
        results.append(row)
    return results


RepairHandler = Callable[[Entry, Emit, Callable | None], bool]
_REPAIR_HANDLERS: dict[str, RepairHandler] = {}


def register_repair(kind: str, handler: RepairHandler) -> None:
    """Register one side-effect owner's recovery handler, idempotently."""
    current = _REPAIR_HANDLERS.get(kind)
    if current is not None and current is not handler:
        raise ValueError(f"journal repair handler already registered for {kind}")
    _REPAIR_HANDLERS[kind] = handler


def repair_kinds() -> tuple[str, ...]:
    return tuple(sorted(_REPAIR_HANDLERS))


def _repair_bench(entry: Entry, _emit: Emit, _login: Callable | None) -> bool:
    """Retained for durable notes written by the removed benchmark command."""
    runner.down(entry.workspace, volumes=True)
    runner.remove(entry.workspace)
    return True


register_repair(BENCH_WORKSPACE, _repair_bench)


def _repair(entry: Entry, emit: Emit, login: Callable | None) -> bool:
    """Dispatch to the side-effect owner without importing that owner."""
    if not runner.exists(entry.workspace):
        return True
    handler = _REPAIR_HANDLERS.get(entry.kind)
    return bool(handler and handler(entry, emit, login))


def pending_seed(workspace: str) -> dict:
    """The seed an interrupted create asked for and never ran, or {}.

    Read from the NOTE rather than from the workspace's metadata, because that is the
    only place it survives: the `CreateReq` died with the process, and
    `meta.extra["seed"]` is written only after a seed has already succeeded -- so
    metadata can say "seeded" or say nothing, and "nothing" covers both "none was
    asked for" and "one was asked for and lost".

    Only OPEN notes count. A note whose owner is still alive belongs to a create that
    is still running, and finishing its seed underneath it would seed twice.
    """
    for entry in abandoned():
        if entry.kind == CREATE_UNFINISHED and entry.workspace == workspace:
            if entry.detail.get("seed"):
                return dict(entry.detail)
    return {}
