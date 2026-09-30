import { ctx } from "./shared.js";

// ---- load-test diagnosis rendering -----------------------------------------
function resultTable(headers, rows) {
  const t = ctx.el("table", { class: "dtable" }, ctx.el("tr", {}, ...headers.map((h) => ctx.el("th", {}, h))));
  for (const row of rows) {
    t.append(ctx.el("tr", {}, ...row.map((cell, i) =>
      ctx.el("td", i ? { class: "v" } : {}, String(cell)))));
  }
  return t;
}
const ms = (v) => (v == null ? "-" : `${Math.round(v)}ms`);

// p95 per bucket as a sparkline, with error buckets marked. timeline.render_ascii
// is terminal art; this reuses the SVG approach from the live stats chart.
function timelineSvg(tl) {
  const b = tl.buckets || [];
  if (b.length < 2) return null;
  const W = 560, H = 74, pad = 4;
  const max = Math.max(...b.map((x) => x.p95), 1);
  const x = (i) => pad + (i / (b.length - 1)) * (W - 2 * pad);
  const y = (v) => H - 18 - (v / max) * (H - 26);
  const line = b.map((x_, i) => `${x(i).toFixed(1)},${y(x_.p95).toFixed(1)}`).join(" ");
  const marks = b.map((x_, i) => x_.errors
    ? `<rect x="${(x(i) - 1.5).toFixed(1)}" y="${H - 14}" width="3" height="8" fill="var(--red)"/>` : "").join("");
  const wrap = ctx.el("div", { class: "spark" });
  wrap.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" width="100%" style="height:auto;display:block" font-size="9">` +
    `<polyline points="${line}" fill="none" stroke="var(--blue)" stroke-width="1.6"/>${marks}` +
    `<text x="${pad}" y="${H - 3}" fill="var(--muted)">0s</text>` +
    `<text x="${W - pad}" y="${H - 3}" fill="var(--muted)" text-anchor="end">${Math.round(tl.span_s || 0)}s</text>` +
    `<text x="${pad}" y="9" fill="var(--muted)">peak p95 ${Math.round(max)}ms</text></svg>`;
  return wrap;
}

function renderDiagnosis(pre, r) {
  const s = r.summary || {}, d = r.diag || {};
  const section = (label, node) => {
    if (!node) return;
    pre.append(ctx.el("div", { class: "section-label" }, label));
    pre.append(node);
  };

  if (r.slo && r.slo.length) {
    section("SLO rules", resultTable(["rule", "threshold", "actual", ""], r.slo.map((x) => [
      x.key, `${x.op} ${x.raw}`,
      x.measured === false ? "not measured" : (x.key === "error" ? `${x.actual.toFixed(2)}%`
        : x.key === "rps" ? x.actual.toFixed(1) : ms(x.actual)),
      x.ok ? "PASS" : "FAIL"])));
  }
  // Per-step latency is the single most useful table for a journey run: it names
  // the slow step instead of leaving you with one aggregate p95.
  const steps = s.steps || {};
  const order = ["login", "rooms", "open", "post", "sync", "read"];
  const names = Object.keys(steps).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  if (names.length) {
    section("Per-step latency", resultTable(["step", "count", "p50", "p95", "p99"],
      names.map((n) => [n, Math.round(steps[n].count || 0), ms(steps[n].p50), ms(steps[n].p95), ms(steps[n].p99)])));
  }
  const st = s.status || {};
  const codes = ["2xx", "429", "4xx", "5xx", "other"].filter((k) => st[k]);
  if (codes.length) {
    section("Responses", resultTable(["class", "count"], codes.map((k) => [k, Math.round(st[k])])));
  }
  if (d.rcmetrics && Object.keys(d.rcmetrics).length) {
    section("RC internals", resultTable(["instance", "event-loop lag peak", "lag p99", "heap peak", "ddp users"],
      Object.keys(d.rcmetrics).sort().map((svc) => {
        const m = d.rcmetrics[svc];
        const peak = m.eventloop_lag_max_s || m.eventloop_lag_s, p99 = m.eventloop_lag_p99_s;
        return [svc, peak ? ms(peak.max * 1000) : "-", p99 ? ms(p99.max * 1000) : "-",
          m.heap_used_bytes ? `${Math.round(m.heap_used_bytes.max / 1e6)}MB` : "-",
          m.ddp_users ? Math.round(m.ddp_users.max) : "-"];
      })));
  }
  const mg = d.mongo;
  if (mg && (mg.total || (mg.slow || []).length)) {
    section(`Slow MongoDB queries (${mg.total} profiled, ${mg.collscan} COLLSCAN)`,
      resultTable(["time", "namespace", "op", "plan", "docs", "returned"],
        (mg.slow || []).map((q) => [ms(q.millis), q.ns, q.op, q.plan || "?", q.docs, q.ret])));
  }
  if (d.timeline) {
    const spark = timelineSvg(d.timeline);
    if (spark) {
      section(`Latency over time (${d.timeline.buckets.length} buckets of ${d.timeline.width_s}s)`, spark);
      if (d.timeline.first_error_s != null) {
        pre.append(ctx.el("div", { class: "inline-note" }, `errors began ~${d.timeline.first_error_s}s in`));
      }
    }
  }
  if (r.resources && Object.keys(r.resources).length) {
    section("Resource cost", resultTable(["container", "idle CPU", "peak CPU", "peak RAM"],
      Object.keys(r.resources).sort().map((c) => {
        const x = r.resources[c];
        return [c, `${Math.round(x.idle_cpu)}%`, `${Math.round(x.peak_cpu)}%`,
          `${Math.round(x.peak_mem / 1e6)}MB`];
      })));
  }
  pre.scrollTop = pre.scrollHeight;
}

// ---- capacity dialog --------------------------------------------------------
let CAP_TARGET = null;
function openCap(name) { CAP_TARGET = name; ctx.$("#cap-title").textContent = `Capacity search: ${name}`; ctx.$("#cap-dialog").showModal(); }
async function submitCap() {
  const f = ctx.$("#cap-form");
  const req = {
    scenario: f.scenario.value, slo: f.slo.value.trim(),
    start: parseInt(f.start.value, 10) || 10, max_vus: parseInt(f.max_vus.value, 10) || 640,
    step_duration: f.step_duration.value.trim() || "20s", users_n: parseInt(f.users_n.value, 10) || 0,
    constrain: f.constrain.value.trim(),
  };
  ctx.$("#cap-dialog").close();
  try { const { job_id } = await ctx.api(`/api/repros/${CAP_TARGET}/capacity`, { method: "POST", body: JSON.stringify(req) });
    ctx.streamJob(job_id, `Capacity: ${CAP_TARGET}`, renderCapResult); }
  catch (e) { ctx.toast(e.message); }
}
function renderCapResult(r) {
  const pre = ctx.$("#job-log");
  const box = ctx.el("div", { class: "result" });
  box.innerHTML = `<hr><b>Capacity: ${ctx.escapeHtml(r.result)}</b>` + (r.why ? `<br><span class="warn">${ctx.escapeHtml(r.why)}</span>` : "");
  const t = ctx.el("table", { class: "dtable" }, ctx.el("tr", {}, ctx.el("th", {}, "VUs"), ctx.el("th", {}, "req/s"), ctx.el("th", {}, "p95"), ctx.el("th", {}, "err"), ctx.el("th", {}, "lag peak"), ctx.el("th", {}, "result")));
  for (const s of (r.steps || [])) t.append(ctx.el("tr", {},
    ctx.el("td", {}, s.vus), ctx.el("td", { class: "v" }, (s.rps || 0).toFixed(1)),
    ctx.el("td", { class: "v" }, (s.p95 || 0).toFixed(0) + "ms"), ctx.el("td", { class: "v" }, ((s.error_rate || 0) * 100).toFixed(2) + "%"),
    ctx.el("td", { class: "v" }, s.lag_max_s ? `${Math.round(s.lag_max_s * 1000)}ms` : "-"),
    ctx.el("td", { class: s.ok ? "" : "v" }, s.ok ? "PASS" : "FAIL")));
  pre.append(box, t); pre.scrollTop = pre.scrollHeight;
}

function doDefault(name) {
  return ctx.runAction(name, "Make default", async () => {
    await ctx.api(`/api/repros/${name}/default`, { method: "POST" });
    ctx.toast(`${name} is now the default repro`, "ok");
  });
}
let PAT_HEADERS = "";
// Through runAction, not a bare fetch: this is a login plus a 2FA-guarded POST
// against a workspace that may still be booting, so it can sit there for tens of
// seconds. Silent, it looked like a dead button -- and the second click would
// *regenerate* the token, invalidating the one the first click was about to show.
function doPat(name) {
  return ctx.runAction(name, "API token", async () => {
    const r = await ctx.api(`/api/repros/${name}/pat`, { method: "POST", body: JSON.stringify({}) });
    PAT_HEADERS = `-H "X-Auth-Token: ${r.token}" -H "X-User-Id: ${r.user_id}"`;
    ctx.$("#pat-title").textContent = `PAT and Token: ${name}`;
    ctx.$("#pat-body").textContent =
      `# ${r.root_url}  (label: ${r.label}, bypass_2fa: ${r.bypass_2fa})\n`
      + `X-Auth-Token: ${r.token}\nX-User-Id: ${r.user_id}\n\n`
      + `curl ${PAT_HEADERS} ${r.root_url}/api/v1/me\n`;
    ctx.$("#pat-dialog").showModal();
  });
}

// ---- API call console -------------------------------------------------------
// `houston api` in the GUI: pick a method and path, get the status and body
// back in place. Not routed through runAction like the buttons above -- this
// dialog is meant to be used repeatedly, so it disables its own Send button for
// the duration instead of freezing every other action on the repro.
let CALL_TARGET = null;
let CALL_TEXT = "";
// Rocket.Chat answers with JSON on one unbroken line -- a users.list is a single
// wrapped blob you cannot read. Indent it. Two things it must not do: choke on a
// body that isn't JSON (a proxy's HTML error page, a bare 204), and freeze the
// tab re-serialising a huge one, so both fall through to the raw text with the
// reason shown next to the status.
const PRETTY_MAX = 512 * 1024;
function prettyJson(text) {
  if (text.length > PRETTY_MAX) return { text, note: "too large to indent" };
  try { return { text: JSON.stringify(JSON.parse(text), null, 2), note: "" }; }
  catch (_) { return { text, note: "not JSON — shown raw" }; }
}
function openCall(name) {
  CALL_TARGET = name;
  CALL_TEXT = "";
  ctx.$("#call-title").textContent = `API call: ${name}`;
  const out = ctx.$("#call-out");
  out.textContent = "";
  out.hidden = true;                      // no stale response from the last repro
  ctx.$("#call-dialog").showModal();
}
async function submitCall() {
  // Through .elements, not `f.method` -- `method` is a real HTMLFormElement
  // property (the form's own HTTP method). A control named `method` only shadows
  // it by the legacy override rule, so `f.method` would quietly become the string
  // "get" the day this field is renamed. .elements has no such collision.
  const f = ctx.$("#call-form").elements;
  const req = {
    method: f.method.value, path: f.path.value.trim(), data: f.data.value.trim(),
    pat: f.pat.checked, two_fa: f.two_fa.checked,
  };
  if (!req.path) { ctx.toast("enter an API path, e.g. /api/v1/me"); return; }
  const btn = ctx.$("#call-send");
  const out = ctx.$("#call-out");
  btn.disabled = true; btn.textContent = "Sending…";
  out.hidden = false;
  out.textContent = `${req.method} ${req.path} …`;
  try {
    const r = await ctx.api(`/api/repros/${CALL_TARGET}/call`, { method: "POST", body: JSON.stringify(req) });
    // A 4xx/5xx from Rocket.Chat arrives here as a successful call with a
    // failing status -- colour it red, but show it as a response, not an error.
    const shown = r.text ? prettyJson(r.text) : { text: "", note: "empty body" };
    CALL_TEXT = shown.text;               // copy what is on screen, indentation and all
    out.textContent = "";
    out.append(
      ctx.el("span", { class: r.status < 400 ? "done" : "error" },
        `${req.method} ${r.url}\nHTTP ${r.status}  [${r.tag}]  in ${r.elapsed_ms}ms`
        + (shown.note ? `  ·  ${shown.note}` : "") + "\n\n"),
      shown.text);
  } catch (e) {
    CALL_TEXT = e.message;
    out.textContent = "";
    out.append(ctx.el("span", { class: "error" }, e.message));
  } finally {
    btn.disabled = false; btn.textContent = "Send";
    out.scrollTop = 0;
  }
}

// ---- doctor -----------------------------------------------------------------
// The badge could only say docker up/down. When it said down, every card showed
// "docker unavailable — actions disabled" and nothing said WHY or what to do,
// while `houston doctor` had known the answer all along.
const DOCTOR_MARK = { ok: "✓", warn: "⚠", fail: "✗" };
const DOCTOR_VERDICT = {
  ok: ["ok", "All good — houston is ready."],
  warn: ["warn", "Usable, with warnings above."],
  fail: ["bad", "Not ready — fix the ✗ item(s) above."],
};
async function openDoctor() {
  const body = ctx.$("#doctor-body");
  body.innerHTML = "";
  body.append(ctx.el("div", { class: "kv" }, "Checking…"));
  if (!ctx.$("#doctor-dialog").open) ctx.$("#doctor-dialog").showModal();
  let rep;
  try { rep = await ctx.api("/api/doctor"); }
  catch (e) { body.innerHTML = ""; body.append(ctx.el("p", { class: "banner bad" }, e.message)); return; }
  body.innerHTML = "";
  for (const c of rep.checks || []) {
    body.append(ctx.el("div", { class: "dcheck " + c.status },
      ctx.el("span", { class: "dmark" }, DOCTOR_MARK[c.status] || "·"),
      ctx.el("span", {}, c.message)));
  }
  // No repro tally. `houston doctor` prints one because a terminal has nowhere
  // else to say it; here the rail lists every workspace by name and the status bar
  // counts them, both of them permanently and both of them behind this dialog.
  const [cls, text] = DOCTOR_VERDICT[rep.verdict] || DOCTOR_VERDICT.warn;
  body.append(ctx.el("p", { class: "banner " + cls }, text));
}


Object.defineProperties(ctx, {
  "resultTable": { enumerable: true, get: () => resultTable },
  "ms": { enumerable: true, get: () => ms },
  "timelineSvg": { enumerable: true, get: () => timelineSvg },
  "renderDiagnosis": { enumerable: true, get: () => renderDiagnosis },
  "CAP_TARGET": { enumerable: true, get: () => CAP_TARGET, set: value => { CAP_TARGET = value; } },
  "openCap": { enumerable: true, get: () => openCap },
  "submitCap": { enumerable: true, get: () => submitCap },
  "renderCapResult": { enumerable: true, get: () => renderCapResult },
  "doDefault": { enumerable: true, get: () => doDefault },
  "PAT_HEADERS": { enumerable: true, get: () => PAT_HEADERS, set: value => { PAT_HEADERS = value; } },
  "doPat": { enumerable: true, get: () => doPat },
  "CALL_TARGET": { enumerable: true, get: () => CALL_TARGET, set: value => { CALL_TARGET = value; } },
  "CALL_TEXT": { enumerable: true, get: () => CALL_TEXT, set: value => { CALL_TEXT = value; } },
  "PRETTY_MAX": { enumerable: true, get: () => PRETTY_MAX },
  "prettyJson": { enumerable: true, get: () => prettyJson },
  "openCall": { enumerable: true, get: () => openCall },
  "submitCall": { enumerable: true, get: () => submitCall },
  "DOCTOR_MARK": { enumerable: true, get: () => DOCTOR_MARK },
  "DOCTOR_VERDICT": { enumerable: true, get: () => DOCTOR_VERDICT },
  "openDoctor": { enumerable: true, get: () => openDoctor },
});
export { resultTable, ms, timelineSvg, renderDiagnosis, CAP_TARGET, openCap, submitCap, renderCapResult, doDefault, PAT_HEADERS, doPat, CALL_TARGET, CALL_TEXT, PRETTY_MAX, prettyJson, openCall, submitCall, DOCTOR_MARK, DOCTOR_VERDICT, openDoctor };
