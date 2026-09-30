import { ctx } from "./shared.js";

// ---- activity (jobs) --------------------------------------------------------
// A job outlives the dialog that started it AND a page refresh, but nothing could
// list one: a 20-minute capacity search whose dialog got closed finished server-side
// with its result unreachable. The manager already retains them (MAX_JOBS), so
// this only needed somewhere to look.
// A seed job had NO result renderer, so the browser saw the progress lines and
// then nothing -- while the CLI printed a table. That mattered less when the result
// was four counts; it carries the room breakdown and the readback verdict now, and
// the verdict is the whole reason to look: it is the difference between "the seeder
// says it made 283 messages" and "283 messages are in there".
function renderSeedResult(r) {
  const pre = ctx.$("#job-log");
  const box = ctx.el("div", { class: "result" });
  const kv = (k, v, cls = "") => ctx.el("div", { class: cls }, ctx.el("b", {}, k + ": "), v);
  box.append(ctx.el("div", { html: "<hr>" }));
  box.append(kv("Seeded", `${r.users || 0} users · ${r.messages || 0} messages · `
    + `${r.threads || 0} in threads · ${r.rooms_total || 0} rooms`));
  const kinds = Object.entries(r.rooms || {}).sort();
  if (kinds.length) box.append(kv("Rooms", kinds.map(([k, n]) => `${k} ${n}`).join(" · ")));
  const v = r.verification;
  if (v) {
    const faults = v.faults || [], extra = v.extra || [], unread = v.unreadable || [];
    if (!faults.length && !unread.length && !extra.length) {
      // Green because it is confirmed, not merely finished.
      box.append(kv("Readback", `${v.checked} rooms match the plan`, "green"));
    } else {
      if (faults.length) {
        box.append(kv("Readback", `${faults.length} mismatch(es)`, "bad"));
        for (const f of faults.slice(0, 6)) {
          box.append(ctx.el("div", { class: "hint" },
            `· ${f.room || "users"}: wanted ${f.want}, found ${f.got}`));
        }
      }
      // Amber, not red, and stated as what it is: seeding only ever adds, so more
      // than planned means the room had content already.
      if (extra.length) {
        box.append(ctx.el("div", { class: "hint" },
          `· ${extra.length} room(s) hold more than this run planned — they had `
          + `content already (a re-seed, a preset, a restore). Not a fault.`));
      }
      for (const u of unread.slice(0, 4)) {
        box.append(ctx.el("div", { class: "hint" },
          `· ${u.what} could not be read back (${u.why}) — a gap in the check, not a fault`));
      }
    }
  }
  pre.append(box);
  pre.scrollTop = pre.scrollHeight;
}

const JOB_RESULT_RENDERER = {
  create: ctx.renderCreateResult, up: ctx.renderCreateResult,
  monitor: ctx.renderCreateResult, "monitor-off": ctx.renderCreateResult,
  seed: renderSeedResult,
  loadtest: ctx.renderPerfResult, capacity: ctx.renderCapResult,
};
const jobTitle = (j) => (j.label ? `${j.kind}: ${j.label}` : j.kind);
function jobAge(j) {
  const end = j.finished_at || Date.now() / 1000;
  const s = Math.max(0, Math.round(end - j.started_at));
  const dur = s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
  if (j.status === "queued") return "waiting for a slot";
  return j.status === "running" ? `${dur} and counting` : dur;
}
let ACT_TAB = "running";

async function openJobs(tab) {
  if (tab) ACT_TAB = tab;
  ctx.setView("activity");
  ctx.$(".panes").classList.add("no-detail");
  ctx.$("#actpane").innerHTML = "";
  const panel = ctx.$("#detail");
  panel.innerHTML = "";
  const head = ctx.el("div", { class: "home-head" }, ctx.el("h1", {}, "Activity"),
    ctx.el("p", {}, "What is running right now, and everything that has happened on this box."));
  const tabs = ctx.el("div", { class: "tabs", id: "act-tabs" },
    ctx.el("button", { class: "tab" + (ACT_TAB === "running" ? " active" : ""), id: "act-tab-running",
                   onclick: () => openJobs("running") }, "In progress"),
    ctx.el("button", { class: "tab" + (ACT_TAB === "history" ? " active" : ""), id: "act-tab-history",
                   onclick: () => openJobs("history") }, "History"));
  head.append(tabs);
  const body = ctx.el("div", { class: "home-body" });
  const card = ctx.el("div", { class: "hcard" });
  const cardhead = ctx.el("div", { class: "jobs-head" });
  cardhead.append(ctx.el("p", { class: "hint", id: "jobs-hint" }, ACT_TAB === "running"
    ? "Jobs keep running on the server after you leave this page — including across "
      + "a refresh. Click one to reopen its output."
    : (ctx.canAdmin()
        ? "Everything anyone has done on this box. Refusals are recorded too."
        : "Everything you have done on this box. Admins see everyone's.")));
  const filter = ctx.el("div", { id: "jobs-filter", class: "row2" },
    ctx.el("input", { id: "act-grep", class: "input", placeholder: "filter by action or target…",
                  "aria-label": "filter activity",
                  oninput: () => { if (ACT_TAB === "history") renderHistory(ctx.$("#jobs-list")); } }),
    ctx.el("label", { class: "toggle" },
      ctx.el("input", { type: "checkbox", id: "act-denied",
                    onchange: () => { if (ACT_TAB === "history") renderHistory(ctx.$("#jobs-list")); } }),
      "refusals only"));
  filter.hidden = ACT_TAB !== "history";
  cardhead.append(filter);
  const box = ctx.el("div", { id: "jobs-list", class: "jobs" });
  box.append(ctx.el("p", { class: "empty" }, "loading…"));
  card.append(cardhead, box);
  body.append(card);
  panel.append(head, body);
  if (ACT_TAB === "running") return renderRunning(box);
  return renderHistory(box);
}

async function renderRunning(box) {
  let rows;
  try { rows = (await ctx.api("/api/jobs")).jobs; }
  catch (e) { box.innerHTML = ""; box.append(ctx.el("p", { class: "empty" }, e.message)); return; }
  box.innerHTML = "";
  // FILTERED. The tab is labelled "In progress" and rendered every retained job, so
  // finished and failed ones sat under it -- which makes the one question this view
  // exists to answer, "is anything running right now", unanswerable. History is the
  // other tab and already shows all of them.
  const all = rows.length;
  rows = rows.filter((j) => ctx.jobActive(j.status));
  if (!rows.length) {
    box.append(ctx.el("div", { class: "empty" }, all
      ? `Nothing running. ${all} finished job${all === 1 ? "" : "s"} in History.`
      : "No jobs yet."));
    return;
  }
  for (const j of rows) {
    // The API has returned `actor` since accounts landed and this dropped it on
    // the floor -- which is most of why the shared box could not answer "who?".
    const who = ctx.el("span", { class: "jmeta" });
    if (j.actor) who.append(ctx.el("span", { class: "jactor" }, j.actor));
    box.append(ctx.el("button", {
      class: "jobrow", type: "button", onclick: () => reopenJob(j),
      title: "Reopen this job's output",
    },
      ctx.el("span", { class: "jstatus " + j.status }, j.status),
      ctx.el("span", { class: "jkind" }, jobTitle(j)),
      who,
      ctx.el("span", { class: "jage" }, jobAge(j))));
  }
}

async function renderHistory(box) {
  const q = ctx.$("#act-grep").value.trim();
  const denied = ctx.$("#act-denied").checked;
  let res;
  try { res = await ctx.api("/api/audit?limit=200" + (q ? `&q=${encodeURIComponent(q)}` : "")); }
  catch (e) { box.innerHTML = ""; box.append(ctx.el("p", { class: "empty" }, e.message)); return; }
  const rows = (res.lines || []).filter((r) => !denied || r.outcome === "denied");
  box.innerHTML = "";
  if (!rows.length) { box.append(ctx.el("p", { class: "empty" }, "Nothing recorded yet.")); return; }
  for (const r of rows) {
    const who = ctx.el("span", { class: "jmeta" });
    if (r.actor && r.actor !== "-") who.append(ctx.el("span", { class: "jactor" }, r.actor));
    // Origin is only shown when it is NOT a checked session: that is the common,
    // trustworthy case, and a column saying "session" on every line teaches
    // nothing. It rides inside the actor cell so the row keeps four columns.
    if (r.origin && r.origin !== "session") {
      who.append(ctx.el("span", { class: "pill small", title: "how this identity was established" },
                    r.origin));
    }
    box.append(ctx.el("div", { class: "jobrow" + (r.outcome === "denied" ? " denied" : "") },
      ctx.el("span", { class: "jstatus " + (r.outcome === "denied" ? "error" : "done") },
        r.outcome === "denied" ? "denied" : r.kind),
      ctx.el("span", { class: "jkind" }, r.label),
      who,
      ctx.el("span", { class: "jage" }, (r.ts || "").slice(0, 19).replace("T", " "))));
  }
  if (res.truncated) {
    box.append(ctx.el("p", { class: "hint" },
      "Stopped early — the log is large. Filter it, or ship it somewhere with an index."));
  }
}
// since=0, so the retained events replay from the start; the terminal event is
// among them, which is what re-renders a finished job's result table.
function reopenJob(j) { ctx.streamJob(j.id, jobTitle(j), JOB_RESULT_RENDERER[j.kind]); }

// ---- create dialog ----------------------------------------------------------
let PRESETS = [];
let ACME_EMAIL_REMEMBERED = false;
// Who may set rc_image / reg_token / bind, and which fields those are -- both from
// the server, which owns the policy (gui.create_policy). Defaulting to false means
// a failed /api/settings hides them rather than offering fields the create would
// reject.
let MAY_SET_PRIVILEGED = false;
let PRIVILEGED_FIELDS = ["rc_image", "reg_token", "bind"];
// The box's own default, from the server -- not a guess and not a constant written
// here. Starts at the shipped default so the notice is right before /api/settings
// has answered.
let DEFAULT_BIND_HOST = "127.0.0.1";

async function openCreate(preset) {
  try { PRESETS = (await ctx.api("/api/presets")).presets; } catch (e) { ctx.toast(e.message); return; }
  // Whether `config set acme.email` has been run. The email field is optional only
  // if it has -- and the GUI cannot set it, so a first-time user must be told to
  // type one rather than discovering it from a failed job.
  try {
    const s = await ctx.api("/api/settings");
    ACME_EMAIL_REMEMBERED = s.acme_email_remembered;
    MAY_SET_PRIVILEGED = !!s.may_set_privileged;
    if (s.default_bind_host) DEFAULT_BIND_HOST = s.default_bind_host;
    if (Array.isArray(s.privileged_fields) && s.privileged_fields.length) {
      PRIVILEGED_FIELDS = s.privileged_fields;
    }
    // Rebuilt every open rather than cached: a cluster can appear or go away while
    // the tab is up, and a stale list would offer one the create then refuses.
    const csel = ctx.$("#context-select");
    if (csel) {
      // ROWS, not names: which of these costs money is decided by the service and
      // sent here, rather than re-derived from the shape of the name in JS. This
      // dialog already learned that lesson about the refusal registry.
      ctx.KUBE_CLUSTERS = Array.isArray(s.kube_clusters) ? s.kube_clusters : [];
      const was = csel.value;
      csel.innerHTML = "";
      const fallback = ctx.KUBE_CLUSTERS.find((c) => c.is_default);
      // The three things "decide for me" can mean, said rather than left to be
      // discovered: this saved cluster, the only one there is, or a local one that
      // does not exist yet and will be built.
      const only = ctx.KUBE_CLUSTERS.length === 1 ? ctx.KUBE_CLUSTERS[0] : null;
      const willBuild = !ctx.KUBE_CLUSTERS.length && (ctx.KUBE || {}).can_provision;
      csel.append(ctx.el("option", { value: "" },
        fallback ? `Decide for me — ${ctx.clusterLabel(fallback)}`
        : only ? `Decide for me — ${ctx.clusterLabel(only)}`
        : willBuild ? "Decide for me — a local cluster will be created"
        : "Decide for me"));
      for (const c of ctx.KUBE_CLUSTERS) {
        // The VALUE is always the full context — it is what gets sent, and shortening
        // that would send a name the server cannot resolve. Only the label is short.
        csel.append(ctx.el("option", { value: c.context, title: c.context },
          ctx.clusterLabel(c) + (c.billable ? " · costs money" : "")
          + (c.is_default ? " · default" : "")));
      }
      if (was && ctx.KUBE_CLUSTERS.some((c) => c.context === was)) csel.value = was;
      ctx.syncClusterNote();
    }
    if (Array.isArray(s.runtimes) && s.runtimes.length) {
      ctx.RUNTIMES = s.runtimes;
      const cur = ctx.$("#runtime-value");
      const want = cur.value || s.default_runtime;
      cur.value = ctx.RUNTIMES.some((r) => r.name === want) ? want : ctx.RUNTIMES[0].name;
    }
  } catch (_) { ACME_EMAIL_REMEMBERED = false; MAY_SET_PRIVILEGED = false; }
  // What the box has left, next to the choice that spends it. `up` already REFUSES
  // without headroom, so the cost belongs at the moment of choosing rather than in
  // the failure afterwards -- and this is the same number the refusal uses.
  ctx.$("#create-room").textContent = "";
  ctx.api("/api/machine").then((cap) => {
    if (!cap || !cap.known) return;
    ctx.MACHINE_ROOM = cap;
    ctx.syncRoomLine();
  }).catch(() => {});
  ctx.renderRuntimeAxes();
  ctx.syncHttpsFields();
  const sel = ctx.$("#preset-select");
  sel.innerHTML = "";
  for (const p of PRESETS) sel.append(ctx.el("option", { value: p.name }, p.name + (p.requires_license ? " (license)" : "")));
  sel.value = preset && PRESETS.some((p) => p.name === preset) ? preset : "default";
  ctx.renderPresetParams();
  ctx.$("#create-form").existing.value = "reuse";
  ctx.syncCreateSeed();
  ctx.$("#version-hint").textContent = "";
  // These decide what CODE runs and where it listens, and the server refuses them
  // from whoever `gui.create_policy` says (admin by default, `anyone` on a box
  // where every account is a colleague). Ask the SERVER who that is rather than
  // deciding from the role here: two places computing the same permission is how
  // the dialog ends up offering a field the API rejects, which is exactly what it
  // did -- a server comment claimed the GUI "never sends them for a member", and
  // it sent all three for everybody.
  //
  // Hidden rather than disabled: a greyed-out field invites "why can't I?", and on
  // a box that has opened the policy there is nothing to explain.
  for (const name of PRIVILEGED_FIELDS) {
    // `context` is governed by syncAdvancedForRuntime instead, which ANDs this same
    // policy check with "is the runtime Kubernetes". Handling it here too would win
    // (this loop runs last) and put a cluster picker on Docker Compose.
    if (name === "context") continue;
    const input = ctx.$("#create-form")[name];
    if (input && input.closest("label")) {
      input.closest("label").hidden = !MAY_SET_PRIVILEGED;
      if (!MAY_SET_PRIVILEGED) input.value = "";
    }
  }
  syncBindHint();
  ctx.$("#create-dialog").showModal();
}

// The one thing a browser-only user on a shared server cannot find out any other
// way: a workspace publishes on 127.0.0.1 by default, so the one they are about to
// create will answer on the server and nowhere else -- including not in the browser
// they are creating it from. Shown only when that is actually true: not on a laptop
// (loopback browser), and not on a box whose default bind host has already been
// widened, where it would be noise about a problem that no longer exists.
function syncBindHint() {
  const hint = ctx.$("#create-bind-hint");
  if (!hint) return;
  const remote = ctx.remoteHost();
  const wide = ctx.WIDE_BINDS.includes(String(DEFAULT_BIND_HOST || ""));
  if (!remote || wide) { hint.hidden = true; hint.textContent = ""; return; }
  hint.hidden = false;
  // ONE LINE. This was four sentences explaining loopback, and it sits above a form
  // somebody is already filling in -- so it restated what the reader could infer and
  // buried the only part that is a decision. It also led with `0.0.0.0`, which on a
  // public box publishes admin/admin123 to the internet; the hostname it can have
  // instead goes through the same front door as this GUI and was never mentioned.
  hint.textContent =
    `Workspaces bind ${DEFAULT_BIND_HOST}, so they will not answer from here — give it a `
    + (MAY_SET_PRIVILEGED
        ? `hostname below, or Bind host 0.0.0.0 (which publishes admin/admin123).`
        : `hostname below, or ask an admin to set bind_host.`);
}

Object.defineProperties(ctx, {
  "renderSeedResult": { enumerable: true, get: () => renderSeedResult },
  "JOB_RESULT_RENDERER": { enumerable: true, get: () => JOB_RESULT_RENDERER },
  "jobTitle": { enumerable: true, get: () => jobTitle },
  "jobAge": { enumerable: true, get: () => jobAge },
  "ACT_TAB": { enumerable: true, get: () => ACT_TAB, set: value => { ACT_TAB = value; } },
  "openJobs": { enumerable: true, get: () => openJobs },
  "renderRunning": { enumerable: true, get: () => renderRunning },
  "renderHistory": { enumerable: true, get: () => renderHistory },
  "reopenJob": { enumerable: true, get: () => reopenJob },
  "PRESETS": { enumerable: true, get: () => PRESETS, set: value => { PRESETS = value; } },
  "ACME_EMAIL_REMEMBERED": { enumerable: true, get: () => ACME_EMAIL_REMEMBERED, set: value => { ACME_EMAIL_REMEMBERED = value; } },
  "MAY_SET_PRIVILEGED": { enumerable: true, get: () => MAY_SET_PRIVILEGED, set: value => { MAY_SET_PRIVILEGED = value; } },
  "PRIVILEGED_FIELDS": { enumerable: true, get: () => PRIVILEGED_FIELDS, set: value => { PRIVILEGED_FIELDS = value; } },
  "DEFAULT_BIND_HOST": { enumerable: true, get: () => DEFAULT_BIND_HOST, set: value => { DEFAULT_BIND_HOST = value; } },
  "openCreate": { enumerable: true, get: () => openCreate },
  "syncBindHint": { enumerable: true, get: () => syncBindHint },
});
export { renderSeedResult, JOB_RESULT_RENDERER, jobTitle, jobAge, ACT_TAB, openJobs, renderRunning, renderHistory, reopenJob, PRESETS, ACME_EMAIL_REMEMBERED, MAY_SET_PRIVILEGED, PRIVILEGED_FIELDS, DEFAULT_BIND_HOST, openCreate, syncBindHint };
