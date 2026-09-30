import { ctx } from "./shared.js";

// ---- logs viewer ------------------------------------------------------------
const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];
const PINO = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };
const MONGOSEV = { D: "debug", I: "info", W: "warn", E: "error", F: "fatal" };
const LOG_MAX = 3000;
const logv = { buf: [], min: "info", svc: "", q: "", follow: true,
               pending: [], frame: 0, unseen: 0, onUnseen: null };

// Lines arrive one WebSocket message at a time, and each one used to do three
// things that cost the whole list: rescan the entire 3000-entry buffer to rebuild
// the service dropdown, append a row, and then READ scrollHeight to follow --
// which forces a synchronous layout. The stream opens with `tail=300`, so that is
// 300 forced reflows back to back before a chatty container has even started, and
// then one per line after it. That is the one-to-two second freeze, and the
// thrash of the view jumping per line instead of settling once.
//
// So: parse and buffer immediately (cheap), and do the DOM once per frame.
function flushLogs() {
  logv.frame = 0;
  const batch = logv.pending;
  logv.pending = [];
  const box = ctx.$("#logview");
  if (!box || !batch.length) return;
  const frag = document.createDocumentFragment();
  for (const e of batch) if (passes(e)) frag.append(logRow(e));
  // Once per frame rather than once per line, and still read from the buffer, so
  // a service that has aged out of it still stops being offered.
  refreshServiceOptions();
  if (!frag.childElementCount) return;
  const added = frag.childElementCount;
  box.append(frag);
  // The buffer is capped and the DOM has to be capped with it, or rows
  // accumulate without limit on a repro that never stops talking.
  while (box.childElementCount > LOG_MAX) box.removeChild(box.firstChild);
  if (logv.follow) { box.scrollTop = box.scrollHeight; return; }
  logv.unseen += added;
  if (logv.onUnseen) logv.onUnseen();
}
function queueLog(e) {
  logv.pending.push(e);
  if (!logv.frame) logv.frame = requestAnimationFrame(flushLogs);
}

// kubectl's `--prefix`: `[pod/<pod>/<container>] the actual line`. On a microservices
// workspace every line arrives like this from nine pods at once, and this function knew
// only Compose's `service-1  | line` -- so the SERVICE column was empty on the runtime
// where it matters most, the filter had nothing to offer, and 55 characters of pod name
// sat in front of every message pushing the content out of alignment. When the line was
// JSON the prefix was silently dropped instead, which is worse: nine pods' logs
// interleaved with no way to tell which said what.
const K8S_PREFIX = /^\[pod\/([^/\]]+)\/([^/\]]+)\]\s?/;

function parseLogLine(line) {
  let service = "", content = line, pod = "";
  const k = K8S_PREFIX.exec(line);
  if (k) {
    pod = k[1];
    // The CONTAINER, not the pod: a pod name carries a replicaset hash that changes on
    // every rollout, and the container is the same word Compose calls a service --
    // `rocketchat`, `ddp-streamer`, `presence`. The chart suffixes half of them with
    // `-service`, which is noise in a 92px column where every row has it.
    service = k[2].replace(/-service$/, "");
    content = line.slice(k[0].length);
  }
  const bar = content.indexOf("|");
  if (!k && bar > 0 && bar < 40) { service = content.slice(0, bar).trim().replace(/-\d+$/, ""); content = content.slice(bar + 1).trim(); }
  let level = "info", msg = content, ts = "";
  const b = content.indexOf("{");
  if (b >= 0) {
    try {
      const o = JSON.parse(content.slice(b));
      msg = o.msg || o.message || content;
      if (typeof o.level === "number") level = PINO[o.level] || "info";
      else if (o.s) level = MONGOSEV[o.s] || "info";
      else if (typeof o.level === "string" && LEVELS.includes(o.level.toLowerCase())) level = o.level.toLowerCase();
      const t = o.time || (o.t && o.t.$date);
      if (t) { const d = new Date(t); if (!isNaN(d)) ts = d.toLocaleTimeString(); }
      if (o.name) msg = `[${o.name}] ${msg}`;
    } catch (_) { /* not JSON — keep raw */ }
  }
  return { service, level, msg, ts, pod, raw: line };
}
function passes(e) {
  return LEVELS.indexOf(e.level) >= LEVELS.indexOf(logv.min)
    && (!logv.svc || e.service === logv.svc)
    && (!logv.q || e.msg.toLowerCase().includes(logv.q));
}
function logRow(e) {
  // The pod on the service cell's tooltip: two replicas of one service are the same
  // word in this column, and which of the two said it is occasionally the whole
  // question. Not in the column itself -- a replicaset hash is 20 characters of noise
  // on every row to answer a question nobody asks most of the time.
  return ctx.el("div", { class: "logrow lv-" + e.level },
    ctx.el("span", { class: "lt" }, e.ts || ""),
    ctx.el("span", { class: "ll lv-" + e.level }, e.level.toUpperCase()),
    ctx.el("span", { class: "ls", title: e.pod || "" }, e.service || ""),
    ctx.el("span", { class: "lm" }, e.msg));
}
// The service filter's options, rebuilt from whatever services the buffer has seen.
// Its own function because it has TWO callers: a full re-render, and each arriving
// log line. It used to live only inside renderLogList(), which the WebSocket handler
// never calls -- it appends rows straight to the DOM to avoid re-rendering the whole
// list per line. So the dropdown stayed on "all services" no matter how many
// services were streaming, and only filled in once something ELSE forced a
// re-render: changing the level, typing in search, or toggling follow.
function refreshServiceOptions() {
  const sel = ctx.$("#log-svc"); if (!sel) return;
  const svcs = [...new Set(logv.buf.map((e) => e.service).filter(Boolean))].sort();
  // Nothing to do when the options already match; this runs per log line.
  const shown = [...sel.options].map((o) => o.value).filter(Boolean);
  if (shown.length === svcs.length && shown.every((s, i) => s === svcs[i])) return;
  const cur = logv.svc;
  // Built with el() rather than an innerHTML template: a "service" is just the
  // text before the first `|` of a container log line (parseLogLine), so it is
  // attacker-influenced content and must never be parsed as markup.
  sel.innerHTML = "";
  sel.append(ctx.el("option", { value: "" }, "all services"));
  for (const s of svcs) sel.append(ctx.el("option", { value: s }, s));
  // A service that has aged out of the buffer shows "all services", as the
  // previous `selected`-attribute build did (setting .value to a missing
  // option would instead blank the select).
  if (!svcs.includes(cur)) logv.svc = "";   // else passes() filters to permanent empty
  sel.value = logv.svc;
}

function renderLogList() {
  const box = ctx.$("#logview"); if (!box) return;
  // One fragment, one insertion: appending 3000 rows straight into a live node
  // relaid the list 3000 times, which is the same defect as the stream had.
  const frag = document.createDocumentFragment();
  for (const e of logv.buf) if (passes(e)) frag.append(logRow(e));
  box.innerHTML = "";
  box.append(frag);
  refreshServiceOptions();
  if (logv.follow) box.scrollTop = box.scrollHeight;
}
function renderLogs(body, d) {
  logv.buf = [];
  const ctl = ctx.el("div", { class: "logctl" });
  const levelSel = ctx.el("select", { class: "input", onchange: (e) => { logv.min = e.target.value; renderLogList(); } },
    ...["trace", "debug", "info", "warn", "error"].map((l) => ctx.el("option", { value: l }, l + "+")));
  levelSel.value = logv.min;
  const svcSel = ctx.el("select", { id: "log-svc", class: "input", onchange: (e) => { logv.svc = e.target.value; renderLogList(); } }, ctx.el("option", { value: "" }, "all services"));
  const search = ctx.el("input", { class: "input", placeholder: "search…", "aria-label": "filter log lines",
    oninput: (e) => { logv.q = e.target.value.trim().toLowerCase(); renderLogList(); } });
  // logv persists across tab switches by design, but the input was rebuilt EMPTY --
  // so an active search looked like "the container stopped logging".
  search.value = logv.q;
  const followCb = ctx.el("input", { type: "checkbox", onchange: (e) => { logv.follow = e.target.checked; renderLogList(); } });
  followCb.checked = logv.follow;
  const follow = ctx.el("label", { class: "logfollow" }, followCb, " follow");
  const clear = ctx.el("button", { class: "btn small", onclick: () => { logv.buf = []; renderLogList(); } }, "Clear");
  // What the stream is DOING. Without this, "connected and the container is quiet"
  // and "the socket was refused ten seconds ago" are the same picture: an empty
  // box. Five minutes of that is unreadable, and it is the state you most need
  // named, because the two have nothing in common as problems.
  const stat = ctx.el("span", { class: "logstat", id: "log-stat" });
  ctl.append(levelSel, svcSel, search, follow, clear, stat);
  if (d.grafana_url) ctl.append(ctx.el("a", { class: "linkchip monitor", href: d.grafana_url + "/d/houston-logs", target: "_blank" }, "Logs in Grafana (Loki)"));
  const box = ctx.el("div", { class: "logview", id: "logview" });
  // The way back. Scrolling up detaches you from the stream, so there has to be
  // one press that returns -- and it says how much arrived while you were reading,
  // which is the thing you actually want to know before you go back.
  const jump = ctx.el("button", { class: "logjump", id: "log-jump", hidden: true,
    onclick: () => { box.scrollTop = box.scrollHeight; } });
  const setJump = () => {
    jump.textContent = logv.unseen ? `↓ ${logv.unseen} new` : "↓ Latest";
  };
  setJump();
  // Following is a PLACE, not a mode you have to remember to switch off. Scroll up
  // to read something and the stream stops dragging you back; scroll to the bottom
  // and it picks up again. The checkbox says which, so the state is never a
  // mystery -- and untangling that is most of what "lots of scrolling" was.
  box.addEventListener("scroll", () => {
    const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    if (atEnd === logv.follow) return;
    logv.follow = atEnd;
    followCb.checked = atEnd;
    if (atEnd) logv.unseen = 0;
    jump.hidden = atEnd;
    setJump();
  }, { passive: true });
  logv.onUnseen = setJump;
  body.append(ctx.el("div", { class: "logbox" }, ctl, box, jump));

  const proto = location.protocol === "https:" ? "wss" : "ws";
  // No credential in the URL any more: the session cookie rides along on the
  // upgrade automatically, which is the only reason ?t= ever existed here.
  const setStat = (kind, text, retry) => {
    stat.className = "logstat " + kind;
    stat.textContent = text;
    if (retry) {
      stat.append(ctx.el("button", { class: "logretry", onclick: () => ctx.renderDetail() }, "Retry"));
    }
  };
  setStat("wait", "connecting…");

  const ws = new WebSocket(`${proto}://${location.host}/api/repros/${d.name}/logs/stream?tail=300`);
  ctx.dstate.logsWS = ws;
  let opened = false, got = 0;
  ws.onopen = () => {
    opened = true;
    setStat("live", "streaming");
    // A container that has printed nothing looks exactly like a broken stream.
    // After a few seconds of an OPEN socket with no line, say which it is.
    setTimeout(() => {
      if (ctx.dstate.logsWS === ws && ws.readyState === 1 && !got) {
        setStat("idle", "connected · nothing logged yet");
      }
    }, 4000);
  };
  ws.onmessage = (m) => {
    if (!got++) setStat("live", "streaming");
    const e = parseLogLine(m.data);
    logv.buf.push(e);
    if (logv.buf.length > LOG_MAX) logv.buf.shift();
    // Buffered unfiltered, deliberately: a service that only logs at info still
    // has to appear in the filter while the level is set to error, or you cannot
    // select the service whose errors you are looking for.
    queueLog(e);
  };
  // A socket that never opened was refused or never arrived -- the server closes
  // before accept() for a missing session or an insufficient role, and a browser
  // reports that as a failed handshake, not as a close code worth printing. One
  // that opened and then closed is a stream that ended, which is a different
  // sentence and a different thing to do about it.
  ws.onclose = () => {
    if (ctx.dstate.logsWS !== ws) return;           // superseded by a newer stream
    ctx.dstate.logsWS = null;
    setStat("bad", opened ? "stream ended" : "could not connect — refused or unreachable", true);
  };
  ws.onerror = () => { if (ctx.dstate.logsWS === ws && !opened) setStat("bad", "could not connect", true); };
}

function startStats() {
  if (ctx.dstate.statsTimer) clearInterval(ctx.dstate.statsTimer);
  // ONE IN FLIGHT, AND ONLY FOR THE WORKSPACE THAT ASKED. `docker stats` can take
  // most of a minute on a loaded box while this fires every three seconds, so
  // without a guard the calls pile up and each one makes the next slower. And the
  // response carries no workspace name: a poll started for A that lands after the
  // reader has clicked B pushed A's CPU and memory onto B's chart, which is a
  // plausible-looking wrong answer rather than a visible glitch.
  let inFlight = false;
  const poll = async () => {
    if (document.hidden) return;   // same reasoning as the dashboard poll below
    if (inFlight) return;
    const asked = ctx.SELECTED;
    inFlight = true;
    try {
      const s = await ctx.api(`/api/repros/${asked}/stats`);
      if (asked !== ctx.SELECTED) return;      // the reader moved on; this is A's data
      ctx.dstate.points.push({ cpu: s.cpu || 0, mem: s.mem_mb || 0 });
      if (ctx.dstate.points.length > 60) ctx.dstate.points.shift();
      drawChart();
    } catch (e) {
      // A refusal will not fix itself in three seconds. kind ships no
      // metrics-server, so a Kubernetes workspace answers 409 to this forever --
      // and swallowing it left an empty box under a title that says "live",
      // repainting every 3s, while the server's own instructions for fixing it
      // were thrown away. Stop asking and show them.
      if (e && (e.status === 409 || e.status === 400)) {
        if (ctx.dstate.statsTimer) { clearInterval(ctx.dstate.statsTimer); ctx.dstate.statsTimer = null; }
        const box = ctx.$("#chart");
        if (box) { box.innerHTML = ""; box.append(ctx.el("p", { class: "hint pre" }, e.message)); }
      }
      /* anything else is transient: keep polling */
    } finally {
      // RELEASED ON EVERY PATH, including the early return above. A guard that
      // leaks stops the chart forever, which is a worse failure than the pile-up
      // it prevents.
      inFlight = false;
    }
  };
  poll();
  ctx.dstate.statsTimer = setInterval(poll, 3000);
}

// Compatibility bindings for browser diagnostics and the existing behavioural
// tests. The fragments share lexical code, but explicit exports make these
// implementation-coupled helpers observable without exposing new server API.

const STATS_INTERVAL_S = 3;
// A round ceiling that does not throw away the panel. [1,2,2.5,5,10] sent a peak
// of 1090 MB to an axis of 2000, so the line drew across the middle of an empty
// box; the finer steps put it at 1500 and the shape is readable again.
function niceMax(v, floor) {
  v = Math.max(v, floor);
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}
// Seconds, always. The buffer holds 60 samples at STATS_INTERVAL_S, so this axis
// can never span more than three minutes -- and switching units inside that range
// produced "-2m -1m -59s", where the third label is larger than the second it
// sits to the right of. Fractional minutes ("-1.9m") were no better.
function fmtAgo(s) { return s <= 0 ? "now" : `-${s}s`; }

/* CPU and memory, as two panels rather than two lines on one plot.

   It was a DUAL-AXIS chart: CPU % scaled to the left edge, MB to the right, both
   drawn on the same grid. Where those two lines cross, and which one looks
   higher, is decided entirely by the two independent `niceMax` calls -- so the
   picture invents a relationship between CPU and memory that is not in the data,
   and changes it whenever either series happens to peak. Two measures on two
   scales are two charts.

   Each panel now has one series and one honest axis, they share the time axis at
   the bottom, and the latest value is written at the end of its own line -- which
   is the number you actually came for, and it was previously only inferable by
   eye against an axis. One hue for both: a single series per panel needs no
   colour to tell it apart from anything, and green is spoken for elsewhere in
   this interface (green = running). */
function drawChart() {
  const box = ctx.$("#chart"); if (!box) return;
  const pts = ctx.dstate.points;
  const n = pts.length;
  const W = 600, mL = 42, mR = 58, PH = 78, PGAP = 26, TOP = 16, XBAND = 22;
  const H = TOP + PH + PGAP + PH + XBAND;
  const x0 = mL, x1 = W - mR;
  const px = (i) => (n < 2 ? x1 : x0 + (i / (n - 1)) * (x1 - x0));
  const MUT = "var(--muted)", DIM = "var(--dim)", GRID = "var(--line)";
  const HUE = "var(--accent-fill)", SURF = "var(--panel)";

  let g = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="height:auto;display:block" `
    + `font-family="ui-monospace, Menlo, monospace" font-size="10" `
    + `role="img" aria-label="CPU percent and memory in megabytes over the last few minutes">`;

  const panel = (top, key, title, unit, floor, fmt) => {
    const yTop = top, yBot = top + PH;
    const max = niceMax(Math.max(...pts.map((p) => p[key]), 0), floor);
    const py = (v) => yBot - (v / max) * (yBot - yTop);
    let s = `<text x="${x0}" y="${yTop - 5}" fill="${MUT}">${title}</text>`;
    // Solid hairlines. Dashed gridlines read as a threshold or a projection when
    // they are only a grid.
    for (const f of [0, 0.5, 1]) {
      const y = yBot - f * (yBot - yTop);
      s += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${GRID}"/>`;
      s += `<text x="${x0 - 6}" y="${y + 3}" fill="${DIM}" text-anchor="end">${fmt(max * f)}</text>`;
    }
    if (n < 2) {
      return s + `<text x="${(x0 + x1) / 2}" y="${(yTop + yBot) / 2}" fill="${DIM}" `
        + `text-anchor="middle">collecting…</text>`;
    }
    const line = pts.map((p, i) => `${px(i).toFixed(1)},${py(p[key]).toFixed(1)}`).join(" ");
    s += `<polygon points="${x0},${yBot} ${line} ${x1},${yBot}" fill="${HUE}" opacity=".10"/>`;
    s += `<polyline points="${line}" fill="none" stroke="${HUE}" stroke-width="2" `
      + `stroke-linejoin="round" stroke-linecap="round"/>`;
    // The end of the line is where the reader looks, so it carries a marker and
    // the current number. The ring is the surface colour, not a border.
    const last = pts[n - 1][key], ly = py(last);
    s += `<circle cx="${x1}" cy="${ly.toFixed(1)}" r="4" fill="${HUE}" stroke="${SURF}" stroke-width="2"/>`;
    s += `<text x="${x1 + 9}" y="${(ly + 3.5).toFixed(1)}" fill="var(--ink)" font-weight="700">`
      + `${fmt(last)}<tspan fill="${DIM}" font-weight="400"> ${unit}</tspan></text>`;
    return s;
  };

  g += panel(TOP, "cpu", "CPU", "%", 10, (v) => v.toFixed(0));
  g += panel(TOP + PH + PGAP, "mem", "Memory", "MB", 100, (v) => v.toFixed(0));

  // One time axis under both, because both panels are the same window.
  const yAx = TOP + PH + PGAP + PH;
  const span = (n - 1) * STATS_INTERVAL_S;
  for (let k = 0; k <= 4; k++) {
    const f = k / 4, x = x0 + f * (x1 - x0);
    g += `<text x="${x}" y="${yAx + 14}" fill="${DIM}" text-anchor="middle">`
      + `${fmtAgo(Math.round((1 - f) * span))}</text>`;
  }
  box.innerHTML = g + `</svg>`;
}

// ---- actions ----------------------------------------------------------------
async function refreshDetail({ force = false } = {}) {
  if (!ctx.SELECTED) return;
  const name = ctx.SELECTED;
  let d;
  try { d = await ctx.api(`/api/repros/${name}/detail`); } catch (_) { return; }   // keep old
  if (ctx.SELECTED !== name) return;
  ctx.dstate.detail = d;
  // Re-rendering rebuilds the tab body, which resets logv.buf and reopens the log
  // WebSocket -- so an unrelated job finishing used to blank the log the user was
  // reading. A slightly stale header beats losing the logs; it refreshes on switch.
  // `force` is for a finished lifecycle action, which MUST redraw: its spinner is
  // in the action row, so skipping the render would strand "Stopping…" on screen.
  if (!force && ctx.dstate.tab === "logs" && ctx.dstate.logsWS) return;
  ctx.renderDetail();
}
// Stop/start/restart take real time -- `docker compose stop` alone spends RC's 10s
// SIGTERM grace period, and a Kubernetes stop waits up to 60s for pods to go -- so
// they are jobs, and the job dialog carries the feedback runAction used to.
const STATE_LABEL = { stop: "Stop", start: "Start", restart: "Restart" };
async function doState(name, action) {
  // A JOB, like every other operation that takes real time. On Kubernetes a stop
  // waits up to 60s for pods to go and says so while it waits; as a blocking call
  // all of that was discarded and the button just sat there.
  //
  // A KUBERNETES START IS ALSO NOT FINISHED WHEN THE SCALE RETURNS. The URL is a
  // port-forward that died with the old pod, and one can only be attached after the
  // pod is ready. The service reports that as `needs_ready` rather than leaving this
  // file to infer it from "did anything get emitted" -- a proxy that would answer
  // wrongly the moment any other warning was added.
  try {
    const { job_id } = await ctx.api(`/api/repros/${name}/state`,
                                 { method: "POST", body: JSON.stringify({ action }) });
    ctx.streamJob(job_id, `${STATE_LABEL[action] || action}: ${name}`, async (res) => {
      await ctx.loadRepros();
      if (res && res.needs_ready) {
        try {
          const r = await ctx.api(`/api/repros/${name}/ready`, { method: "POST" });
          ctx.streamJob(r.job_id, `Waiting for ${name} to serve`, ctx.renderCreateResult);
        } catch (e) { ctx.toast(e.message); }
      }
    });
  } catch (e) { ctx.toast(e.message); }
}
async function doMonitor(name, off) {
  if (off && !confirm(`Detach Prometheus + Grafana from ${name}?\n\nThis also deletes their data volumes.`)) return;
  try {
    const { job_id } = await ctx.api(`/api/repros/${name}/monitor?off=${off ? "true" : "false"}`, { method: "POST" });
    ctx.streamJob(job_id, `${off ? "Detaching" : "Attaching"} monitoring: ${name}`, ctx.renderCreateResult);
  } catch (e) { ctx.toast(e.message); }
}
async function doBringUp(name) {
  try {
    const { job_id } = await ctx.api(`/api/repros/${name}/up`, { method: "POST" });
    ctx.streamJob(job_id, `Bringing up ${name}`, ctx.renderCreateResult);
  } catch (e) { ctx.toast(e.message); }
}
async function doDown(name) {
  // Two steps so Cancel can actually abort: the single confirm sent the DELETE
  // on both branches, so a mis-click still tore the stack down.
  if (!confirm(`Remove ${name}'s containers?\n\nOK to continue, Cancel to abort.`)) return;
  // Everyone can act on everything -- that is deliberate, support engineers cover
  // for each other. What they must not do is destroy a colleague's data without
  // being told whose it is.
  const owner = (ctx.ALL_REPROS.find((r) => r.name === name) || {}).owner
              || (ctx.ALL_REPROS.find((r) => r.name === name) || {}).created_by || "";
  const whose = owner && owner !== ctx.ME
    ? `\n\nThis workspace belongs to ${owner}, not you — the server will refuse `
      + `unless you are an admin.\nHand it over first:  houston chown -n ${name} --to ${ctx.ME}`
    : "";
  const vol = confirm(
    `Also DELETE ${name}'s data volume and record?${whose}\n\n` +
    `OK = delete everything (irreversible).\nCancel = keep the data.`);
  // A job now. Measured at 48-61s on Kubernetes, where the teardown waits for the
  // namespace and its PersistentVolumeClaims to actually go -- a wait worth watching
  // rather than a button that looks hung for a minute.
  try {
    const { job_id } = await ctx.api(`/api/repros/${name}?volumes=${vol}&confirm=${vol}`,
                                 { method: "DELETE" });
    ctx.streamJob(job_id, `${vol ? "Destroying" : "Stopping"} ${name}`, () => ctx.loadRepros());
  } catch (e) { ctx.toast(e.message); }
}
// ---- seed dialog ------------------------------------------------------------
let SEED_TARGET = null;
function openSeed(name) {
  SEED_TARGET = name;
  ctx.$("#seed-title").textContent = `Seed data: ${name}`;
  ctx.$("#seed-mode").value = "profile";
  syncSeedMode();
  ctx.$("#seed-dialog").showModal();
}
function syncSeedMode() {
  const scale = ctx.$("#seed-mode").value === "scale";
  ctx.$("#seed-profile-row").hidden = scale;
  ctx.$("#seed-scale-row").hidden = !scale;
  ctx.$("#seed-hint").textContent = scale
    ? "Bulk Mongo insert: credential-less users, no app hooks. For scale/perf only."
    : "Creates real, loginable users/channels/messages via the REST API.";
}
async function submitSeed() {
  const f = ctx.$("#seed-form");
  const scale = f.mode.value === "scale";
  // Validate first: closing the dialog before checking discarded the typed spec and
  // reset the mode selector, so the user had to re-pick "Bulk --scale" every time.
  if (scale && !f.scale.value.trim()) { ctx.toast("enter a scale spec"); return; }
  ctx.$("#seed-dialog").close();
  try {
    let job;
    if (scale) {
      job = await ctx.api(`/api/repros/${SEED_TARGET}/scale`, { method: "POST", body: JSON.stringify({ scale: f.scale.value.trim() }) });
      ctx.streamJob(job.job_id, `Scale prefill: ${SEED_TARGET}`);
    } else {
      job = await ctx.api(`/api/repros/${SEED_TARGET}/seed`, { method: "POST", body: JSON.stringify({ profile: f.profile.value }) });
      // The renderer goes here as well as in JOB_RESULT_RENDERER: the table only
      // covers reopening a job from Activity, and the run you just started is the
      // one you are watching.
      ctx.streamJob(job.job_id, `Seeding ${SEED_TARGET} (${f.profile.value})`,
                ctx.renderSeedResult);
    }
  } catch (e) { ctx.toast(e.message); }
}
async function clearScale() {
  if (!confirm(`Remove all --scale data from ${SEED_TARGET}?`)) return;
  ctx.$("#seed-dialog").close();
  try { const { job_id } = await ctx.api(`/api/repros/${SEED_TARGET}/scale`, { method: "DELETE" }); ctx.streamJob(job_id, `Clearing scale data: ${SEED_TARGET}`); }
  catch (e) { ctx.toast(e.message); }
}

Object.defineProperties(ctx, {
  "LEVELS": { enumerable: true, get: () => LEVELS },
  "PINO": { enumerable: true, get: () => PINO },
  "MONGOSEV": { enumerable: true, get: () => MONGOSEV },
  "LOG_MAX": { enumerable: true, get: () => LOG_MAX },
  "logv": { enumerable: true, get: () => logv },
  "flushLogs": { enumerable: true, get: () => flushLogs },
  "queueLog": { enumerable: true, get: () => queueLog },
  "K8S_PREFIX": { enumerable: true, get: () => K8S_PREFIX },
  "parseLogLine": { enumerable: true, get: () => parseLogLine },
  "passes": { enumerable: true, get: () => passes },
  "logRow": { enumerable: true, get: () => logRow },
  "refreshServiceOptions": { enumerable: true, get: () => refreshServiceOptions },
  "renderLogList": { enumerable: true, get: () => renderLogList },
  "renderLogs": { enumerable: true, get: () => renderLogs },
  "startStats": { enumerable: true, get: () => startStats },
  "STATS_INTERVAL_S": { enumerable: true, get: () => STATS_INTERVAL_S },
  "niceMax": { enumerable: true, get: () => niceMax },
  "fmtAgo": { enumerable: true, get: () => fmtAgo },
  "drawChart": { enumerable: true, get: () => drawChart },
  "refreshDetail": { enumerable: true, get: () => refreshDetail },
  "STATE_LABEL": { enumerable: true, get: () => STATE_LABEL },
  "doState": { enumerable: true, get: () => doState },
  "doMonitor": { enumerable: true, get: () => doMonitor },
  "doBringUp": { enumerable: true, get: () => doBringUp },
  "doDown": { enumerable: true, get: () => doDown },
  "SEED_TARGET": { enumerable: true, get: () => SEED_TARGET, set: value => { SEED_TARGET = value; } },
  "openSeed": { enumerable: true, get: () => openSeed },
  "syncSeedMode": { enumerable: true, get: () => syncSeedMode },
  "submitSeed": { enumerable: true, get: () => submitSeed },
  "clearScale": { enumerable: true, get: () => clearScale },
});
export { LEVELS, PINO, MONGOSEV, LOG_MAX, logv, flushLogs, queueLog, K8S_PREFIX, parseLogLine, passes, logRow, refreshServiceOptions, renderLogList, renderLogs, startStats, STATS_INTERVAL_S, niceMax, fmtAgo, drawChart, refreshDetail, STATE_LABEL, doState, doMonitor, doBringUp, doDown, SEED_TARGET, openSeed, syncSeedMode, submitSeed, clearScale };
