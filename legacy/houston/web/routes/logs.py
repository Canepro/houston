"""Container logs: the polled tail, and the WebSocket that streams them live.

**This is the one endpoint that runs the guard chain itself.** A WebSocket handshake
never reaches HTTP middleware, so `logs_stream` re-checks Host, cross-site, the session
cookie and the role table before it accepts — and it calls the SHARED checks in
`web/security.py` rather than keeping a shorter copy of the list. That second copy is
how the Origin check went missing here once already, and a forged
`Origin: https://evil.example` streamed a workspace's container log with its LDAP bind
passwords and OAuth client secrets in it. An invariant test walks every `WebSocketRoute`
and fails if the handler does not call `route_requirement()` and `_cross_site()`.

`logs_stream` binds its context with a walrus in the Host check rather than on a line
of its own, so the move out of `create_app()` costs the function not one line: at 170
raw lines it is already over the structure cap and `tools/structure_check.py` records
that number per subject, so a move that grew it would read as a regression rather than
as the relocation it is. Phase 02b splits it properly.

The two pre-credential refusals — Host and Origin — are coalesced per address per
window, because they are exactly the set an unauthenticated caller can drive at will and
`audit.log` rotates.
"""
from __future__ import annotations

import asyncio
import threading

from fastapi import WebSocket, WebSocketDisconnect

from houston import config
from houston import exec as subprocess
from houston import runner
from houston.errors import ReproError, as_payload as error_body
from houston.services import audit as auditsvc
from houston.services import lifecycle as lc
from houston.services import sessions
from houston.services import topology
from houston.web import security
from houston.web.context import AppContext
from houston.web.routes import _deps


#: The module's one entry point. The handlers below are public NAMES -- FastAPI reports
#: a route by its function name and the suite patches some of them -- but `register` is
#: the only thing anything outside this package may reach for, and a test walks the
#: imports to prove nothing does.
__all__ = ("register",)

# `docker compose logs --tail N` is buffered in memory server-side, so a
# caller-supplied N needs a ceiling.
TAIL_MAX = 5000


# Bounded so a chatty container plus a slow reader can't grow the queue forever.
#
# 3000 matches LOG_MAX in app.js, and that is the whole reason for the number: the
# browser keeps 3000 rows and discards the rest, so anything held beyond that can
# never be displayed. The old 10_000 bought nothing and cost 19 MB per stream when
# the lines were stack traces (measured; 1.95 MB for ordinary 148-byte compose
# lines, which is why this was never a memory PROBLEM -- see `make_log_offer` for
# what it actually was).
WS_QUEUE_MAX = 3_000


def open_log_process(workspace, tail: int):
    """Start `docker compose logs -f` for one workspace.

    A named function for the same reason make_log_offer() is one: it is the single
    docker call the log endpoint makes, and a test that wants to drive the log
    viewer without an engine needs somewhere to stand. The alternative — patching
    `subprocess.Popen` — reaches every other docker call in the process, including
    the stats poll and the edge status check that run at the same moment, and turns
    an unrelated failure into a mystery.
    """
    return subprocess.popen(
        ["docker", "compose", "logs", "-f", "--no-color", "--tail", str(tail)],
        cwd=workspace, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1)


def make_log_offer(q, dropped: list):
    """The log stream's overflow policy: drop the OLDEST line, and count it.

    A named function at module scope rather than a closure inside the WebSocket
    handler, because which END gets dropped is the entire behaviour of that screen
    and it deserves a test that does not need a browser and a chatty container.

    It used to discard the NEWEST line. Once a busy container filled the queue,
    everything arriving from then on was thrown away while the viewer sat rendering
    a window from minutes ago — on a panel with a "follow" checkbox ticked.
    Dropping the oldest keeps a live tail live, which is what somebody watching a
    log during an incident is asking for.

    The end-of-stream sentinel (`None`) is never dropped: it is what closes the
    socket, and losing it leaves the browser waiting on a stream that has ended.

    One producer (the pump thread, marshalled onto the event loop) and one consumer,
    so the get_nowait() that frees a slot is always followed by a put that takes it.
    """
    def offer(line: str | None) -> None:
        while True:
            try:
                q.put_nowait(line)
                return
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                    dropped[0] += 1
                except asyncio.QueueEmpty:      # pragma: no cover - see above
                    return
    return offer


def _clamp_tail(tail: int) -> int:
    try:
        return max(1, min(int(tail), TAIL_MAX))
    except (TypeError, ValueError):
        return 200


async def _pump_lines_to_the_client(dropped, proc, q, watcher, ws):
    """Send what the container says until the client goes, or the queue overflows."""
    try:
        while True:
            getter = asyncio.ensure_future(q.get())
            done, _pending = await asyncio.wait(
                {getter, watcher}, return_when=asyncio.FIRST_COMPLETED)
            if watcher in done:
                getter.cancel()
                break
            line = getter.result()
            if line is None:
                break
            if dropped[0]:
                # Say so. A log with a silent gap in it looks complete, and the
                # whole value of this panel is that what it shows is what
                # happened. Sent out of band rather than queued, so the notice
                # never competes for the slot it is reporting on, and coalesced
                # so a burst is one line rather than thousands.
                skipped, dropped[0] = dropped[0], 0
                await ws.send_text(
                    f"... {skipped} line(s) skipped: this container is logging "
                    "faster than the browser is reading. Narrow the service or "
                    "level filter, or use `houston logs`.")
            await ws.send_text(line)
    except WebSocketDisconnect:
        pass
    finally:
        watcher.cancel()
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()


def _start_the_log_pump(tail, target):
    """A bounded queue and the thread that fills it from whichever runtime this is."""
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue(maxsize=WS_QUEUE_MAX)
    # A Kubernetes workspace has no compose project, so the stream would
    # open, produce nothing, and look like a quiet workspace rather than an
    # unsupported one. Refused before the socket carries anything.
    # No refusal here any more. A Kubernetes workspace streams through
    # `kubectl logs -l app.kubernetes.io/name=rocketchat`; telling a browser
    # user to run kubectl was advice they had no way to take.
    #
    # Dispatched HERE rather than inside open_log_process, so each seam stays
    # what it says it is: that one is the single docker call, k8s.log_process is
    # the single kubectl one.
    if topology.of_repro(target) == topology.KUBERNETES:
        from houston.services import k8s
        _meta = runner.read_meta(target)
        proc = k8s.log_process(
            target, tail=_clamp_tail(tail), follow=True,
            context=str((_meta.extra or {}).get(config.EXTRA_CONTEXT) or k8s.CONTEXT))
    else:
        proc = open_log_process(runner.workspace(target), _clamp_tail(tail))

    dropped = [0]
    offer = make_log_offer(q, dropped)

    def pump():
        for line in proc.stdout or []:
            loop.call_soon_threadsafe(offer, line.rstrip("\n"))
        loop.call_soon_threadsafe(offer, None)

    threading.Thread(target=pump, daemon=True).start()
    return dropped, proc, q


async def _refuse_unless_signed_in(ws, ctx, name: str, refuse) -> bool:
    """True when the connection has been refused and closed.

    A WebSocket cannot be answered with a status, so a refusal IS a close --
    which made every one of these a bare `return` in the middle of the handler.
    Saying so once lets the handler read as the four steps it actually is.
    """
    _ws_https = security.resolve_peer(ws.app, ws.headers, ws.client.host if ws.client else "")[1]
    want = _deps.cookie_name(ws, _ws_https)
    raw = ws.cookies.get(want, "")
    # A `__Host-` cookie is PROOF of the scheme, not merely a consequence
    # of it: a browser will not store one without Secure, and will not
    # send it over http. So if it arrives, the browser's hop is https
    # whatever this end concluded -- and this end can conclude otherwise,
    # because a WebSocket scope and an HTTP scope do not always carry the
    # same `client` behind a proxy, which is the whole asymmetry.
    #
    # Only ever in this direction. Honouring the PLAIN name when https was
    # resolved would hand back everything the prefix buys (a sibling
    # workspace on the same parent domain can set a Domain-scoped cookie
    # of the plain name; it cannot set a `__Host-` one).
    if not raw and want == ctx.cookie_name and ctx.cookie_secure in ws.cookies:
        raw = ws.cookies.get(ctx.cookie_secure, "")
        want = ctx.cookie_secure
    sess = sessions.verify(raw)
    if not sess:
        # Which of the two: no cookie by that name at all, or one that no
        # longer verifies. They have different causes -- a scheme the
        # server resolved differently from the one that minted it, versus
        # a session that expired or was revoked -- and the same symptom.
        refuse("no-cookie:" + want if want not in ws.cookies else "stale-session")
        await ws.close(code=1008); return True
    # The role table is consulted here too: the middleware never sees a
    # WebSocket, so a check that lives only there does not cover the one
    # endpoint that streams credentials.
    from houston.services import users as usersvc
    need = security.route_requirement("WS", "/api/repros/{name}/logs/stream")
    if need is None or not usersvc.at_least(usersvc.role_of(sess.user), need):
        auditsvc.audit(sess.user, "logs-open",
                       f"{name} refused=role need={need} have={usersvc.role_of(sess.user)}",
                       origin_="session", outcome="denied")
        await ws.close(code=1008); return True
    # This handler never passes through `guard`, so it publishes its own
    # identity or the logs-open line below is written with no actor.
    auditsvc.set_actor(sess.user)
    auditsvc.set_origin("session")
    return False


async def _stream_until_the_client_goes(dropped, proc, q, ws):
    """Watch for the client hanging up while the lines are pumped to it."""
    async def watch_client() -> None:
        """Completes when the client goes away.

        Without it the handler blocks on q.get() forever for a QUIET
        container: the send that would raise never happens, so the
        `docker compose logs -f` child and the pump thread outlive the
        browser tab indefinitely.
        """
        try:
            while True:
                await ws.receive()
        except Exception:  # noqa: BLE001 - a disconnect of any flavour
            return

    watcher = asyncio.create_task(watch_client())
    return await _pump_lines_to_the_client(dropped, proc, q, watcher, ws)


async def logs_stream(ws: WebSocket, name: str, tail: int = 300):
    # WS bypasses the http middleware, so the same checks run here -- and the
    # cross-site one now runs from the SAME helper `guard` uses, because
    # having a second, shorter copy of this list is exactly how the Origin
    # check went missing here while being present three lines away.
    # Every refusal below says WHICH one it was. A rejected log stream used to
    # be four different silent 1008s: the browser shows "handshake failed:
    # 403" and the server wrote nothing at all, so an operator holding both
    # ends of the connection could not tell a bad Host from a stale cookie
    # from an insufficient role. Recorded as `attempt`, the origin the
    # sign-in throttle already uses for a caller who has not proved anything.
    def refuse(why: str, who: str = "", *, preauth: bool = False) -> None:
        # `preauth` marks the refusals that happen BEFORE any credential is
        # read -- Host and Origin -- which is exactly the set an unauthenticated
        # caller can drive at will. Those are coalesced per address per window;
        # everything after a credential check is recorded every time.
        if preauth:
            peer = getattr(getattr(ws, "client", None), "host", "") or "-"
            if not security._preauth_should_audit(peer, why):
                return
        auditsvc.audit(who or "-", "logs-open", f"{name} refused={why}",
                       origin_="attempt", outcome="denied")

    if not security.host_ok(ctx := _deps.ctx(ws), ws.headers.get("host")):
        refuse("host", preauth=True)
        await ws.close(code=1008); return
    # Before accept(), and before any credential is read. `require_origin` is
    # on only when the credential is ambient: a Basic header is attached by
    # the browser itself, so an absent Origin cannot be trusted. In token mode
    # the ?t= value is the proof and no browser can supply it cross-site, so a
    # header-less client (curl, CI, the tests) still connects.
    if security.cross_site(ctx, ws.headers, require_origin=ws.app.state.accounts):
        # Origin, or the absence of one. A browser always sends it on an
        # upgrade, so "no origin" means a non-browser client -- worth telling
        # apart from an origin that IS present and simply not allowed.
        refuse("origin" if ws.headers.get("origin") else "no-origin",
               preauth=True)
        await ws.close(code=1008); return
    if ws.app.state.accounts:
        if await _refuse_unless_signed_in(ws, ctx, name, refuse):
            return
    await ws.accept()
    try:
        target = lc.resolve_name(name)
        # Once per stream, never per line: these logs carry LDAP bind
        # passwords and OAuth client secrets, so who opened one is worth
        # recording -- and a line per log line would be a denial of service
        # against the log itself.
        auditsvc.record("logs-open", target)
    except ReproError as exc:
        await ws.send_json(error_body(exc)); await ws.close(); return

    dropped, proc, q = _start_the_log_pump(tail, target)

    return await _stream_until_the_client_goes(dropped, proc, q, ws)


def logs(name: str, tail: int = 200):
    target = lc.resolve_name(name)
    lines: list[str] = []
    # DISPATCHED, like the WebSocket handler seventy lines above -- which carries
    # a comment explaining exactly this and was the only half that got it. A
    # Kubernetes workspace answered every request here with compose's "no
    # configuration file provided", so the streaming log view worked and the REST
    # one did not, for the same workspace, in the same GUI.
    if topology.of_repro(target) == topology.KUBERNETES:
        from houston.services import k8s
        meta = runner.read_meta(target)
        context = str((meta.extra or {}).get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
        proc = k8s.log_process(target, context=context,
                               tail=_clamp_tail(tail), follow=False)
        try:
            for line in proc.stdout or []:
                lines.append(line.rstrip("\n"))
        finally:
            proc.wait(timeout=10)
    else:
        runner.compose_stream(target, "logs", "--no-color",
                              "--tail", str(_clamp_tail(tail)),
                              on_line=lines.append)
    return {"name": target, "logs": "\n".join(lines)}


ROUTES = (
    ("websocket", "/api/repros/{name}/logs/stream", logs_stream),
    ("get", "/api/repros/{name}/logs", logs),
)


def register(app, ctx: AppContext) -> None:
    """Attach this module's routes. Registration order inside the module is ROUTES'
    order, which is the order they were declared in the single factory this came from."""
    for verb, path, handler in ROUTES:
        getattr(app, verb)(path)(handler)
