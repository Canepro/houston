import { ctx } from "./shared.js";

// ---- config-import dialog ---------------------------------------------------
let IMPORT_TARGET = null;
let IMPORT_UPLOAD_ID = null;
function openImport(name) {
  IMPORT_TARGET = name;
  ctx.$("#import-title").textContent = `Import customer config: ${name}`;
  ctx.$("#import-file").value = "";
  IMPORT_UPLOAD_ID = null;
  ctx.$("#import-form").only.value = "";
  const plan = ctx.$("#import-plan"); plan.hidden = true; plan.innerHTML = "";
  ctx.$("#import-apply").disabled = true;
  ctx.$("#import-dialog").showModal();
}
async function previewImport() {
  const f = ctx.$("#import-form");
  if (!f.file.files.length) { ctx.toast("choose a settings.json file"); return; }
  const btn = ctx.$("#import-preview");
  if (btn.disabled) return;              // a double-click orphaned a second upload
  btn.disabled = true;
  const fd = new FormData();
  fd.append("file", f.file.files[0]);
  fd.append("only", f.only.value.trim());
  let plan;
  try {
    // `apiForm`, not a bare fetch: `api()` is what redirects to sign-in on 401, and
    // this call opted out of it -- so an expired session showed an error inside a
    // dialog that could no longer do anything. `apiForm` is the multipart sibling
    // (see its comment): it parses and raises, so there is no Response here.
    plan = await ctx.apiForm(`/api/repros/${IMPORT_TARGET}/config-import/plan`, {
      method: "POST", body: fd });
  } catch (e) { ctx.toast(e.message); return; }
  finally { ctx.$("#import-preview").disabled = false; }
  const box = ctx.$("#import-plan");
  const c = plan.counts;
  // Everything below comes from the uploaded dump's setting ids — escape all of
  // it: a crafted `_id` would otherwise run script in a page holding the token.
  let html = `<b>apply ${c.apply}</b> &middot; skip ${c.redacted} redacted, ${c.denied} identity/env`;
  if (plan.oauth_services.length) html += `<br>oauth pre-create: ${escapeHtml(plan.oauth_services.join(", "))}`;
  if (plan.redacted.length) html += `<br><span class="warn">set by hand (redacted): ${escapeHtml(plan.redacted.join(", "))}</span>`;
  html += "<hr>" + plan.apply.map((a) => `<div class="kv"><code>${escapeHtml(a.id)}</code> = ${escapeHtml(a.value)}</div>`).join("");
  box.innerHTML = html; box.hidden = false;
  IMPORT_UPLOAD_ID = plan.upload_id || null;
  ctx.$("#import-apply").disabled = plan.apply.length === 0 || !IMPORT_UPLOAD_ID;
}
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
async function applyImport() {
  ctx.$("#import-dialog").close();
  try { const { job_id } = await ctx.api(`/api/repros/${IMPORT_TARGET}/config-import`, { method: "POST", body: JSON.stringify({ upload_id: IMPORT_UPLOAD_ID }) }); streamJob(job_id, `Importing config: ${IMPORT_TARGET}`); }
  catch (e) { ctx.toast(e.message); }
}
async function showLogs(name) {
  closeJobStream();          // a plain log view must not share the dialog with a job
  openJob(`Logs: ${name}`);
  ctx.$("#job-log").textContent = "loading…";
  try { const { logs } = await ctx.api(`/api/repros/${name}/logs?tail=200`); ctx.$("#job-log").textContent = logs || "(no output)"; }
  catch (e) { ctx.$("#job-log").textContent = "error: " + e.message; }
}
function reportPrune(r) {
  r = r || {};
  const targets = (r.targets || []).length, removed = (r.removed || []).length;
  // ORPHANED NAMESPACES COUNT AS WORK DONE. They and their PersistentVolumeClaims are
  // deleted irreversibly, and reporting only `removed` said "nothing to prune" about
  // a sweep that had just destroyed them -- the same defect the CLI had.
  const orphans = (r.orphans || []).length;
  if (orphans) ctx.toast(`removed ${orphans} orphaned namespace(s): ${(r.orphans || []).join(", ")}`, "ok");
  if (!targets) { if (!orphans) ctx.toast("nothing to prune", "info"); return; }
  if (removed === targets) { ctx.toast(`pruned ${removed}`, "ok"); return; }
  // prune() warns per-repro through emit; those now arrive in the job dialog, and
  // the shortfall is still worth saying out loud here.
  ctx.toast(`pruned ${removed} of ${targets}; ${targets - removed} could not be cleaned up`);
}

// Prune is the same story as Stop -- a synchronous call that removes containers
// and volumes for every `down` repro -- but its button lives in the static top
// bar, so unlike the cards nothing re-renders it and a local swap is enough.
async function withBusy(btn, verb, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.classList.add("working");
  btn.textContent = "";
  btn.append(ctx.el("span", { class: "spin" }), verb);
  try { await fn(); } finally {
    btn.classList.remove("working");
    btn.disabled = false;
    btn.textContent = label;
  }
}
async function doPrune() {
  if (!confirm("Delete every 'down' repro, including data volumes and records?")) return;
  await withBusy(ctx.$("#btn-prune"), "Pruning…", async () => {
    try {
      const { job_id } = await ctx.api("/api/prune",
                                   { method: "POST", body: JSON.stringify({ confirm: true }) });
      streamJob(job_id, "Pruning down workspaces", async (r) => {
        reportPrune(r);
        await ctx.loadRepros();
      });
    } catch (e) { ctx.toast(e.message); }
  });
}

// ---- job streaming (SSE) ----------------------------------------------------
// One dialog, so exactly one job may own it at a time. JOB is that job; a stream
// belonging to anything else must never write into it (two jobs used to interleave
// their output and steal each other's title).
let JOB = null;

function openJob(title) { ctx.$("#job-title").textContent = title; ctx.$("#job-log").textContent = ""; ctx.$("#job-dialog").showModal(); }
function logLine(ev) {
  const line = ctx.el("div", { class: ev.level }, (ev.pct != null ? `[${Math.round(ev.pct)}%] ` : "") + ev.message);
  const pre = ctx.$("#job-log"); pre.append(line); pre.scrollTop = pre.scrollHeight;
}
function closeJobStream() {
  if (JOB && JOB.es) { try { JOB.es.close(); } catch (_) { /* already closed */ } }
  JOB = null;
}

function streamJob(jobId, title, onResult) {
  closeJobStream();                       // a new job supersedes whatever was showing
  openJob(title);
  JOB = { id: jobId, title, onResult, idx: 0, es: null, retries: 0, finished: false };
  connectJob(JOB);
}

function connectJob(job) {
  // `since` resumes from the last event we saw, so a reconnect cannot duplicate
  // or skip lines. The server has always accepted it; nothing used to send it.
  const es = new EventSource(
    `/api/jobs/${job.id}/stream?since=${job.idx}`);
  job.es = es;
  es.onmessage = (m) => {
    if (JOB !== job) { es.close(); return; }      // superseded — do not write here
    if (m.lastEventId) job.idx = Number(m.lastEventId) + 1;
    const ev = JSON.parse(m.data);
    logLine(ev);
    if (ev.terminal) finishJob(job, ev.level === "error", ev.data || {});
  };
  es.onerror = () => {
    es.close();
    if (JOB !== job || job.finished) return;
    // EventSource reports no detail, and closing it defeats its own reconnect, so
    // ask the job endpoint what actually happened instead of freezing the dialog.
    reconcileJob(job);
  };
}

function finishJob(job, failed, data) {
  job.finished = true;
  if (job.es) { try { job.es.close(); } catch (_) { /* already closed */ } }
  ctx.$("#job-title").textContent = failed ? "Failed" : "Done";
  if (!failed && job.onResult && data.result) job.onResult(data.result);
  ctx.loadRepros().then(ctx.refreshDetail);
}

// The slow path, for when SSE cannot be kept open. Ten seconds rather than the
// stream's immediacy: this is a fallback, and a dialog that reports the truth a few
// seconds late is worth far more than one that reports nothing at all.
function pollJobUntilDone(job) {
  const tick = async () => {
    if (JOB !== job || job.finished) return;         // the reader closed or moved on
    let state;
    try { state = await ctx.api(`/api/jobs/${job.id}`); }
    catch (e) {
      logLine({ level: "error", message: `could not query the job: ${e.message}` });
      finishJob(job, true, {});
      return;
    }
    if (ctx.jobActive(state.status)) { setTimeout(tick, 10000); return; }
    logLine(state.status === "error"
      ? { level: "error", message: state.error || "failed" }
      : { level: "info", message: "done" });
    finishJob(job, state.status === "error",
              { result: state.result, error: state.error });
  };
  setTimeout(tick, 10000);
}

async function reconcileJob(job) {
  let state;
  try { state = await ctx.api(`/api/jobs/${job.id}`); }
  catch (e) {
    logLine({ level: "error", message: `progress stream lost, and the job could not be queried: ${e.message}` });
    finishJob(job, true, {});
    return;
  }
  if (ctx.jobActive(state.status)) {
    if (job.retries++ < 5) {
      logLine({ level: "warn", message: "progress stream dropped — reconnecting…" });
      setTimeout(() => { if (JOB === job && !job.finished) connectJob(job); }, 1000);
    } else {
      // GIVING UP ON THE STREAM IS NOT GIVING UP ON THE JOB. This logged "still
      // running" and stopped, so a job that then finished -- or failed -- was never
      // reported in the dialog the reader was watching. A reverse proxy with an idle
      // SSE timeout makes that the normal case, not an edge one.
      //
      // The stream was only ever the fast path; `/api/jobs/<id>` carries the same
      // outcome. So fall back to asking, slowly, until it reaches a terminal state.
      logLine({ level: "warn", message: "the progress stream keeps dropping — "
        + "watching the job's status instead; this dialog will still report the result." });
      pollJobUntilDone(job);
    }
    return;
  }
  // It finished while we were disconnected; this endpoint carries the outcome.
  logLine(state.status === "error"
    ? { level: "error", message: state.error || "failed" }
    : { level: "info", message: "done" });
  // The server keeps a hundred job summaries but only the newest ten results, so
  // an old run reopened from the history has nothing left to render. Say so:
  // an empty panel and a discarded one look identical otherwise.
  if (state.result_dropped) {
    logLine({ level: "warn", message: "this job finished a while ago and its full "
      + "output is no longer held in memory — the progress above is what remains." });
  }
  finishJob(job, state.status === "error", { result: state.result, error: state.error });
}

// The job keeps running server-side when the dialog is dismissed, and there is no
// job list to reopen it from -- so poll for the outcome rather than losing it.
async function watchDetachedJob(job) {
  ctx.toast(`${job.title} continues in the background`, "info");
  for (let i = 0; i < 900; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    let state;
    try { state = await ctx.api(`/api/jobs/${job.id}`); } catch (_) { return; }
    if (ctx.jobActive(state.status)) continue;
    ctx.toast(state.status === "error" ? `${job.title} failed: ${state.error || ""}` : `${job.title} finished`,
          state.status === "error" ? "error" : "ok");
    ctx.loadRepros().then(ctx.refreshDetail);
    return;
  }
}

// ---- load-test dialog -------------------------------------------------------
let PERF_TARGET = null;
function openPerf(name, monitored) {
  PERF_TARGET = name;
  ctx.$("#perf-title").textContent = `Load test: ${name}`;
  const live = ctx.$("#perf-form").live;
  live.checked = false; live.disabled = !monitored;
  ctx.$("#perf-live-row").style.opacity = monitored ? "1" : ".5";
  ctx.$("#perf-dialog").showModal();
}
async function submitPerf() {
  const f = ctx.$("#perf-form");
  const req = {
    scenario: f.scenario.value, vus: parseInt(f.vus.value, 10) || 10,
    duration: f.duration.value.trim() || "30s", users_n: parseInt(f.users_n.value, 10) || 0,
    slo: f.slo.value.trim(), constrain: f.constrain.value.trim(),
    diag: f.diag.checked, stats: f.stats.checked, live: f.live.checked,
  };
  ctx.$("#perf-dialog").close();
  try {
    const { job_id } = await ctx.api(`/api/repros/${PERF_TARGET}/loadtest`, { method: "POST", body: JSON.stringify(req) });
    streamJob(job_id, `Load test: ${PERF_TARGET} (${req.scenario})`, renderPerfResult);
  } catch (e) { ctx.toast(e.message); }
}
function renderCreateResult(r) {
  const pre = ctx.$("#job-log");
  const box = ctx.el("div", { class: "result" });
  const kv = (k, v) => ctx.el("div", {}, ctx.el("b", {}, k + ": "), v);
  box.append(ctx.el("div", { html: "<hr>" }));
  if (r.rc_version) box.append(kv("Rocket.Chat", `${r.rc_version}  ·  Mongo ${r.mongo_tag || "?"}  ·  preset ${r.preset || "?"}`));
  if (r.root_url) box.append(kv("URL", r.root_url));
  if (r.login) box.append(kv("Login", `${r.login.user} / ${r.login.password}`));
  for (const u of (r.instance_urls || [])) box.append(kv("instance", u));
  if (r.grafana_url) box.append(kv("Grafana", r.grafana_url));
  pre.append(box);
  appendNotes(pre, r.notes);
  pre.scrollTop = pre.scrollHeight;
}

// Preset notes carry the things you cannot guess: the Keycloak console URL and
// realm, the /etc/hosts line oidc and presigned s3_minio need, where Mailpit is.
// The CLI prints them after `up` and from `info`; the GUI showed them nowhere.
// A preset's notes are free prose written for a terminal, and dumping them into
// a <div> per line (or a <pre>) makes the one line that MATTERS -- the /etc/hosts
// entry `oidc` does not work without -- look exactly like the sentence beside it.
//
// Three shapes are actually in the data, and none of them are invented:
//   * an INDENTED line is a thing to type or paste: "    127.0.0.1  keycloak",
//     "    http://localhost:8081/admin/...". It gets a code box and a Copy button.
//   * a line CONTAINING a url is a place to go. The url becomes a link.
//   * everything else is prose, and consecutive prose lines are one paragraph --
//     they were wrapped for an 80-column terminal, not written as separate points.
// Urls become links and `backticked` spans become code. Both are already in the
// notes as plain text -- a preset that says "pass --reg-token" or "`loadtest
// --live`" is naming something you type, and leaving the backticks on screen is
// showing the reader the markup instead of the meaning.
//: Words a finished sentence does not end on. A note ending in one of these was
//: wrapped for an 80-column terminal and continues on the next line; a note ending
//: in anything else -- a name, a number, a url, punctuation -- is a complete point.
const WRAPPED_TAIL = new RegExp("\\b(?:a|an|the|and|or|but|of|to|in|on|at|by|for|from|"
  + "with|is|are|was|were|be|been|being|that|which|who|as|its|their|your|our|this|"
  + "these|those|into|than|then|so|if|when|while|it|not|no|any|each|per|via)$");

const TOKEN_RE = /`([^`]+)`|\bhttps?:\/\/[^\s)]+/;

function linkify(line) {
  const out = ctx.el("span", {});
  // "Status -> Targets", "Container logs -> Loki", "Admin → Email": the ASCII
  // spelling is there because a terminal cannot render the arrow, and a browser
  // can. Same character the presets already use where they were free to.
  let rest = String(line).replace(/ -> /g, " → ");
  for (;;) {
    const m = TOKEN_RE.exec(rest);
    if (!m) { out.append(rest); return out; }
    out.append(rest.slice(0, m.index));
    if (m[1]) out.append(ctx.el("code", { class: "inline" }, m[1]));
    else out.append(ctx.el("a", { href: m[0], target: "_blank", rel: "noreferrer" }, m[0]));
    rest = rest.slice(m.index + m[0].length);
  }
}

// A note line that names a PLACE. Every preset that has one writes it the same
// way, because a human wrote it for a human:
//     Keycloak admin console: http://localhost:8081  (admin / admin)
//     Mailpit (EVERY email RC sends, for ALL users, lands here): http://localhost:8025
//     Grafana:    http://localhost:5050  (admin/admin; anonymous view enabled)
// That is a NAME, optionally what it is FOR, a URL, and sometimes the CREDENTIALS
// — the same four things the link rows above already show — and setting it as a
// grey paragraph buried the two facts you came for. The url must START the value:
// "Container logs -> Loki: open the 'Rocket.Chat Logs' dashboard in Grafana (…)"
// mentions a url inside a sentence, and it is a sentence, not a location.
const PLACE_RE = /^([^:()]{2,40}?)(?:\s*\(([^)]*)\))?:[ \t]+((?:https?:\/\/|<)\S*)[ \t]*(?:\(([^)]*)\))?[ \t]*\.?$/;
// "admin/admin; anonymous view enabled" is a password AND a remark; "Status ->
// Targets: rocketchat, …" is only a remark. Only the a/b shape is a credential.
const CREDS_RE = /^([\w.@+-]+ ?\/ ?[\w.@+-]+)(?:[;,]\s*(.*))?$/;
// Past this, a description stops being a column and becomes a second line —
// rather than ellipsising it away, which loses the half of it that matters.
const WHAT_MAX = 34;

// Read a preset's notes into the shapes that are in them. Indentation carries
// most of the structure, and every preset already uses it:
//   4+ spaces  something to type or paste  ("    127.0.0.1  keycloak")
//   2 spaces   a rider on the line above ("  — one shared inbox; …")
//   column 0   a new point — UNLESS the line before it did not finish a
//              sentence, in which case it is just terminal wrapping
//              ("…can reach Keycloak at the" / "same URL RC's backend uses.")
// Joining every consecutive prose line instead, as a first pass did, turned the
// email preset's five separate points into one unreadable wall.
function parseNotes(notes) {
  const items = [];
  let para = null, place = null, prev = "";
  for (const raw of notes || []) {
    const line = String(raw);
    if (!line.trim()) { para = null; place = null; prev = ""; continue; }
    if (/^\s{4,}\S/.test(line)) {
      items.push({ kind: "cmd", value: line.trim() });
      // The paste box ENDS the row above it. saml's last line is a remark about
      // the Keycloak console, but hanging it back on that row prints it above the
      // url the sentence before it promised ("…or open Users directly:").
      para = null; place = null; prev = line.trim();
      continue;
    }
    const indented = /^\s{1,3}\S/.test(line);
    const m = indented ? null : PLACE_RE.exec(line.trim());
    if (m) {
      const paren = (m[4] || "").trim();
      const creds = CREDS_RE.exec(paren);
      place = { kind: "place", label: m[1].trim(), what: (m[2] || "").trim(),
                url: m[3], creds: creds ? creds[1] : "",
                sub: creds ? (creds[2] || "").trim() : paren };
      if (place.what.length > WHAT_MAX) {
        place.sub = place.sub ? place.what + " · " + place.sub : place.what;
        place.what = "";
      }
      items.push(place); para = null; prev = line;
      continue;
    }
    if (place && indented) {                    // a rider on the row above
      place.sub = place.sub ? place.sub + " " + line.trim() : line.trim();
      prev = line;
      continue;
    }
    // A column-0 line continues the one above ONLY if that one broke mid-sentence,
    // and the reliable signal is what it ENDS with. Ending punctuation is not enough
    // on its own: livechat has two separate points that each end in a url, and one
    // that starts with a lowercase username.
    //
    // "Ends in any lowercase word" was too broad, and the Kubernetes notes are what
    // proved it: "monolith on kind-houston-local — about 5 pods, namespace
    // houston-knotes" is a COMPLETE point that happens to end in an identifier, and
    // it was being glued to the MongoDB note that followed it — two facts in one
    // bullet, in the notes a reader consults to find out what their workspace is.
    //
    // So the test is narrower: a line was wrapped only if it trails off in a short
    // FUNCTION word, which is a thing no finished sentence ends with. `oidc`'s
    // "…can reach Keycloak at the" still joins the line after it; a namespace name
    // no longer does. Indented continuations (the 2-space ones `email` and `saml`
    // use) never needed this test and still do not — they are handled above.
    const tail = prev.trim();
    const wrapped = para && WRAPPED_TAIL.test(tail) && !/\/\S*$/.test(tail);
    if (!para || !(indented || wrapped)) {
      para = { kind: "prose", lines: [] };
      items.push(para);
    }
    para.lines.push(line.trim());
    place = null; prev = line;
  }
  return items;
}

// One row shape for "a thing, and where it is", used by the links the server
// reports AND by the note lines that name one, so a scenario's console does not
// appear once as a row and again as a sentence three lines below it.
function placeRow(p) {
  const real = !String(p.url || "").startsWith("<");
  const row = real
    ? ctx.el("a", { class: "linkrow " + (p.kind || ""), href: p.url,
                target: "_blank", rel: "noreferrer" })
    : ctx.el("div", { class: "linkrow static " + (p.kind || "") });
  row.append(ctx.el("span", { class: "l-n" }, p.label));
  if (p.what) row.append(ctx.el("span", { class: "l-w" }, p.what));
  // The url as it will actually open, not as the server spelled it. The href above
  // is already rewritten by localUrl(), and showing the raw one here put two
  // different addresses for the same thing on one screen -- "What is in this
  // workspace" saying localhost:3000 while the URL row below it said the host the
  // GUI was loaded from. Only when it IS a url: `real` is false for a preset
  // placeholder like `<repro-url>/livechat`, and localUrl() would resolve that
  // against the page origin and produce `http://<host>/<repro-url>/livechat`.
  row.append(ctx.el("span", { class: "l-u" }, p.url));
  if (p.creds) row.append(ctx.el("span", { class: "l-c" }, p.creds));
  if (real) row.append(ctx.el("span", { class: "l-go" }, "↗"));
  if (p.sub) row.append(ctx.el("span", { class: "l-sub" }, linkify(p.sub)));
  return row;
}

function renderNoteItems(box, items) {
  let group = null;                       // consecutive places are one table
  // A marker says "this is one point of several". A card holding ONE paragraph is not
  // several, and the dot in front of it reads as a list with one item -- which is
  // what every grouped note card became when the groups arrived and each took one
  // paragraph with it.
  const listed = items.filter((i) => i.kind === "prose").length > 1;
  for (const it of items) {
    if (it.kind !== "place") group = null;
    if (it.kind === "cmd") {
      box.append(ctx.el("div", { class: "note-cmd" },
        ctx.el("code", {}, it.value),
        ctx.el("button", { class: "cp", onclick: () => ctx.copy(it.value) }, "Copy")));
    } else if (it.kind === "place") {
      if (!group) { group = ctx.el("div", { class: "linkrows one" }); box.append(group); }
      group.append(placeRow(it));
    } else {
      const para = ctx.el("p", { class: "note-p" + (listed ? "" : " solo") });
      it.lines.forEach((l, i) => { if (i) para.append(" "); para.append(linkify(l)); });
      box.append(para);
    }
  }
  return box;
}

function noteBlock(notes) {
  return renderNoteItems(ctx.el("div", { class: "notes" }), parseNotes(notes));
}

function appendNotes(parent, notes) {
  if (!notes || !notes.length) return;
  parent.append(ctx.el("div", { class: "section-label" }, "Using this scenario"));
  parent.append(noteBlock(notes));
}

function renderPerfResult(r) {
  const s = r.summary || {};
  const pre = ctx.$("#job-log");
  const box = ctx.el("div", { class: "result" });
  const pill = r.passed ? '<span class="ok">SLO PASS</span>' : (r.slo && r.slo.length ? '<span class="bad">SLO FAIL</span>' : "");
  box.innerHTML =
    `<hr><b>Results</b> ${pill}<br>` +
    `throughput <b>${(s.rps || 0).toFixed(1)} req/s</b> (${(s.count || 0).toFixed(0)} reqs) &middot; ` +
    `errors ${((s.error_rate || 0) * 100).toFixed(2)}%<br>` +
    `latency p50 ${(s.p50 || 0).toFixed(0)}ms &middot; p95 <b>${(s.p95 || 0).toFixed(0)}ms</b> &middot; p99 ${(s.p99 || 0).toFixed(0)}ms`;
  if (r.verdict && r.verdict.length) box.innerHTML += "<br><b>Verdict:</b><br>" + r.verdict.map((v) => "&bull; " + escapeHtml(v)).join("<br>");
  pre.append(box);
  // Everything below was already in the response and was being thrown away. It is
  // the part a support ticket actually needs: WHICH step is slow, whether Mongo did
  // a COLLSCAN, whether the Node event loop saturated, and when errors started.
  ctx.renderDiagnosis(pre, r);
  if (r.grafana_url) {
    const url = `${r.grafana_url}/d/houston-k6-loadtest?from=now-15m&to=now&kiosk`;
    pre.append(ctx.el("div", { class: "result" },
      ctx.el("a", { href: url, target: "_blank", style: "text-decoration:none" }, ctx.el("button", { class: "btn small" }, "Open k6 dashboard in Grafana"))));
    const frame = ctx.el("iframe", { src: url, class: "grafana-embed" });
    pre.append(frame);
  }
  pre.scrollTop = pre.scrollHeight;
}


Object.defineProperties(ctx, {
  "IMPORT_TARGET": { enumerable: true, get: () => IMPORT_TARGET, set: value => { IMPORT_TARGET = value; } },
  "IMPORT_UPLOAD_ID": { enumerable: true, get: () => IMPORT_UPLOAD_ID, set: value => { IMPORT_UPLOAD_ID = value; } },
  "openImport": { enumerable: true, get: () => openImport },
  "previewImport": { enumerable: true, get: () => previewImport },
  "escapeHtml": { enumerable: true, get: () => escapeHtml },
  "applyImport": { enumerable: true, get: () => applyImport },
  "showLogs": { enumerable: true, get: () => showLogs },
  "reportPrune": { enumerable: true, get: () => reportPrune },
  "withBusy": { enumerable: true, get: () => withBusy },
  "doPrune": { enumerable: true, get: () => doPrune },
  "JOB": { enumerable: true, get: () => JOB, set: value => { JOB = value; } },
  "openJob": { enumerable: true, get: () => openJob },
  "logLine": { enumerable: true, get: () => logLine },
  "closeJobStream": { enumerable: true, get: () => closeJobStream },
  "streamJob": { enumerable: true, get: () => streamJob },
  "connectJob": { enumerable: true, get: () => connectJob },
  "finishJob": { enumerable: true, get: () => finishJob },
  "pollJobUntilDone": { enumerable: true, get: () => pollJobUntilDone },
  "reconcileJob": { enumerable: true, get: () => reconcileJob },
  "watchDetachedJob": { enumerable: true, get: () => watchDetachedJob },
  "PERF_TARGET": { enumerable: true, get: () => PERF_TARGET, set: value => { PERF_TARGET = value; } },
  "openPerf": { enumerable: true, get: () => openPerf },
  "submitPerf": { enumerable: true, get: () => submitPerf },
  "renderCreateResult": { enumerable: true, get: () => renderCreateResult },
  "WRAPPED_TAIL": { enumerable: true, get: () => WRAPPED_TAIL },
  "TOKEN_RE": { enumerable: true, get: () => TOKEN_RE },
  "linkify": { enumerable: true, get: () => linkify },
  "PLACE_RE": { enumerable: true, get: () => PLACE_RE },
  "CREDS_RE": { enumerable: true, get: () => CREDS_RE },
  "WHAT_MAX": { enumerable: true, get: () => WHAT_MAX },
  "parseNotes": { enumerable: true, get: () => parseNotes },
  "placeRow": { enumerable: true, get: () => placeRow },
  "renderNoteItems": { enumerable: true, get: () => renderNoteItems },
  "noteBlock": { enumerable: true, get: () => noteBlock },
  "appendNotes": { enumerable: true, get: () => appendNotes },
  "renderPerfResult": { enumerable: true, get: () => renderPerfResult },
});
export { IMPORT_TARGET, IMPORT_UPLOAD_ID, openImport, previewImport, escapeHtml, applyImport, showLogs, reportPrune, withBusy, doPrune, JOB, openJob, logLine, closeJobStream, streamJob, connectJob, finishJob, pollJobUntilDone, reconcileJob, watchDetachedJob, PERF_TARGET, openPerf, submitPerf, renderCreateResult, WRAPPED_TAIL, TOKEN_RE, linkify, PLACE_RE, CREDS_RE, WHAT_MAX, parseNotes, placeRow, renderNoteItems, noteBlock, appendNotes, renderPerfResult };
