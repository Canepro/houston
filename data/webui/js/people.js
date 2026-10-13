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
  const planned = r.planned;
  if (planned) box.append(kv("Planned", `${planned.users} users · ${planned.rooms_total} rooms · `
    + `${planned.messages} messages · ${planned.threads} thread replies · ${planned.files} files`));
  const kinds = Object.entries(r.rooms || {}).sort();
  if (kinds.length) box.append(kv("Rooms", kinds.map(([k, n]) => `${k} ${n}`).join(" · ")));
  if (r.files) box.append(kv("Files", `${r.files} packaged samples`));
  if (r.scenarios && r.scenarios.length) box.append(kv("Scenarios", r.scenarios.join(" · ")));
  if (r.history) box.append(kv("Synthetic history", `${r.history.days} days · ${r.history.oldest} to ${r.history.latest}`));
  if (r.history && r.history.constrained && r.history.constrained.length)
    box.append(kv("History range", `${r.history.constrained.length} room(s) constrained by existing discussion anchors`, "hint"));
  if (Array.isArray(r.created)) {
    const locations = ctx.el("details", {}, ctx.el("summary", {}, "Feature locations and personal star accounts"));
    for (const room of r.created) {
      const details = [];
      if (room.starred_by && room.starred_by.length) details.push(`personal stars: sign in as ${room.starred_by.join(", ")}`);
      if (room.files && room.files.length) details.push(`files: ${room.files.join(", ")}`);
      if (room.kind === "discussion") details.push(`discussion in ${room.parent}`);
      if (details.length) locations.append(kv(room.name, details.join(" · ")));
    }
    if (locations.children.length > 1) box.append(locations);
  }
  const v = r.verification;
  if (v) {
    if (v.features) {
      const rows = [["files", "files", "files"], ["thread_parents", "thread_parents", "thread roots"],
        ["reactions", "reaction_actions", "reactions"], ["pins", "pins", "pins"], ["stars", "stars", "stars"],
        ["mentions", "mentions", "mentions"], ["edits", "edits", "edits"]];
      box.append(kv("Features (read/planned)", rows.map(([actual, expected, label]) =>
        `${v.features[actual] || 0}/${planned && planned[expected] || 0} ${label}`).join(" · ")));
    }
    const faults = v.faults || [], extra = v.extra || [], unread = v.unreadable || [];
    if (v.ok === true && !faults.length && !unread.length && !extra.length) {
      // Green because it is confirmed, not merely finished.
      box.append(kv("Readback", `${v.checked} rooms match the plan`, "green"));
    } else {
      if (v.ok === null || v.ok === undefined) box.append(kv("Readback", "Incomplete: some checks could not run", "hint"));
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
  // Lazily: the cluster module loads after this one.
  "cluster-create": (r) => ctx.renderClusterCreateResult(r),
  "cluster-delete": (r) => ctx.renderClusterDeleteResult(r),
  "cluster-sweep": (r) => ctx.renderClusterSweepResult(r),
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
  let res, jobs;
  try {
    [res, jobs] = await Promise.all([
      ctx.api("/api/audit?limit=200" + (q ? `&q=${encodeURIComponent(q)}` : "")),
      ctx.api("/api/jobs"),
    ]);
  }
  catch (e) { box.innerHTML = ""; box.append(ctx.el("p", { class: "empty" }, e.message)); return; }
  const rows = (res.lines || []).filter((r) => !denied || r.outcome === "denied");
  const finished = denied ? [] : (jobs.jobs || []).filter((j) => !ctx.jobActive(j.status)
    && (!q || `${j.kind} ${j.label}`.toLowerCase().includes(q.toLowerCase())));
  box.innerHTML = "";
  if (finished.length) {
    box.append(ctx.el("div", { class: "section-label" }, "Recent job output"));
    for (const j of finished) {
      const who = ctx.el("span", { class: "jmeta" }, j.actor || "");
      const status = j.error_kind === "Stopped" ? "stopped" : j.status === "error" ? "failed" : "done";
      const target = ctx.el("span", { class: "jkind" }, jobTitle(j));
      if (j.result_dropped) target.append(ctx.el("span", { class: "hint", style: "display:block" },
        "Full output has expired; retained progress is still available."));
      box.append(ctx.el("button", { class: "jobrow", type: "button", "data-job-id": j.id,
        onclick: () => reopenJob(j), title: "Reopen this job's output" },
      ctx.el("span", { class: "jstatus " + j.status }, status), target, who,
      ctx.el("span", { class: "jage" }, jobAge(j))));
    }
  }
  if (!rows.length && !finished.length) { box.append(ctx.el("p", { class: "empty" }, "Nothing recorded yet.")); return; }
  if (rows.length && !denied) {
    box.append(ctx.el("div", { class: "section-label" }, "Recorded activity"),
      ctx.el("p", { class: "hint" }, "Recent jobs can be reopened above. Older job output is no longer retained, "
        + "and is cleared when this server restarts; these activity entries remain."));
  }
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
    const outcome = ["accepted", "done", "error", "stopped", "denied"].includes(r.outcome) ? r.outcome : null;
    const tone = outcome === "error" || outcome === "denied" ? "error" : outcome === "accepted" ? "queued" : "done";
    box.append(ctx.el("div", { class: "jobrow" + (r.outcome === "denied" ? " denied" : "") },
      ctx.el("span", { class: "jstatus " + tone }, outcome === "error" ? "failed" : outcome || r.kind),
      ctx.el("span", { class: "jkind" }, outcome ? `${r.kind}: ${r.label}` : r.label),
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
async function reopenJob(j) {
  let state;
  try { state = await ctx.api(`/api/jobs/${j.id}`); }
  catch (e) {
    if (e.status !== 404) { ctx.toast(e.message); return; }
    ctx.closeJobStream(); ctx.openJob(jobTitle(j));
    ctx.$("#job-title").textContent = "Output unavailable";
    ctx.logLine({ level: "warn", message: "This job's output is no longer retained. Its recorded activity remains in History." });
    return;
  }
  ctx.streamJob(j.id, jobTitle(j), JOB_RESULT_RENDERER[j.kind]);
  if (state.result_dropped) ctx.logLine({ level: "warn", message:
    "This job's full output has expired. The retained progress below is what remains." });
}

// ---- create dialog ----------------------------------------------------------
let PRESETS = [];
let ACME_EMAIL_REMEMBERED = false;
// Who may set rc_image / reg_token / bind / license, and which fields those are -- both
// from the server, which owns the policy (gui.create_policy). Defaulting to false means a
// failed /api/settings disables them rather than offering fields the create would reject.
let MAY_SET_PRIVILEGED = false;
let PRIVILEGED_FIELDS = ["rc_image", "reg_token", "bind"];
// The box's own default, from the server -- not a guess and not a constant written
// here. Starts at the shipped default so the notice is right before /api/settings
// has answered.
let DEFAULT_BIND_HOST = "127.0.0.1";

function seedChoices(catalogue) {
  if (!catalogue || !Array.isArray(catalogue.profiles) || !Array.isArray(catalogue.scenarios)) return;
  for (const select of [ctx.$("#create-form").seed_profile, ctx.$("#seed-form").profile]) {
    const selected = select.value; select.replaceChildren();
    for (const p of catalogue.profiles) select.append(ctx.el("option", {value: p.name}, `${p.name} — ${p.users} users, ${p.rooms} rooms`));
    if (catalogue.profiles.some((p) => p.name === selected)) select.value = selected;
  }
  for (const area of document.querySelectorAll(".seed-scenarios")) {
    area.replaceChildren();
    for (const s of catalogue.scenarios) area.append(ctx.el("label", {},
      ctx.el("input", {type: "checkbox", name: area.dataset.prefix + "scenarios", value: s.name}), ` ${s.title} `,
      ctx.el("span", {class: "opt"}, s.description)));
  }
  for (const input of document.querySelectorAll('[name="history_days"], [name="seed_history_days"]')) {
    if (catalogue.history) { input.min = catalogue.history.minimum; input.max = catalogue.history.maximum; }
  }
}
async function loadSeedChoices() { try { seedChoices((await ctx.api("/api/settings")).seed_options); } catch (e) { ctx.toast(e.message); } }
function seedRequest(form, prefix = "") {
  const toggle = form.elements.namedItem(prefix + "history"), days = form.elements.namedItem(prefix + "history_days");
  const out = {scenarios: Array.from(form.querySelectorAll(`input[name="${prefix}scenarios"]:checked`)).map((c) => c.value)};
  if (toggle.checked) {
    const value = Number(days.value);
    if (!Number.isSafeInteger(value) || value < Number(days.min) || value > Number(days.max)) {
      ctx.toast(`history days must be an integer from ${days.min} to ${days.max}`); days.focus(); return null;
    }
    out.history_days = value;
  }
  return out;
}

// `dest` preselects a place ("docker", "k8s:<context>", "eks:<context>") and opens on
// the details, which is what "Create here" on the Clusters page means.
async function openCreate(preset, { dest = "" } = {}) {
  try { PRESETS = (await ctx.api("/api/presets")).presets; } catch (e) { ctx.toast(e.message); return; }
  // Whether `config set acme.email` has been run: the email field is optional only if it has.
  try {
    const s = await ctx.api("/api/settings");
    seedChoices(s.seed_options);
    ACME_EMAIL_REMEMBERED = s.acme_email_remembered;
    MAY_SET_PRIVILEGED = !!s.may_set_privileged;
    if (s.default_bind_host) DEFAULT_BIND_HOST = s.default_bind_host;
    if (Array.isArray(s.privileged_fields) && s.privileged_fields.length) {
      PRIVILEGED_FIELDS = s.privileged_fields;
    }
    // Rebuilt every open: a cluster can appear or go away while the tab is up. ROWS, not
    // names -- which one costs money is the service's decision. The GUI offers local
    // Kubernetes and EKS; every other kubeconfig context stays a command-line choice,
    // and is kept here only so the box default can be described truthfully.
    ctx.ALL_KUBE_CLUSTERS = Array.isArray(s.kube_clusters) ? s.kube_clusters : [];
    // Not a cluster still being built: it is not a place to run anything yet.
    ctx.KUBE_CLUSTERS = ctx.ALL_KUBE_CLUSTERS.filter((c) => c.where !== "elsewhere" && !ctx.clBuilding(c));
    const csel = ctx.$("#context-select");
    if (csel) {
      csel.innerHTML = "";
      csel.append(ctx.el("option", { value: "" }, "the server's default"));
      for (const c of ctx.KUBE_CLUSTERS) csel.append(ctx.el("option", { value: c.context }, ctx.clusterLabel(c)));
    }
    if (Array.isArray(s.runtimes) && s.runtimes.length) ctx.RUNTIMES = s.runtimes;
  } catch (_) { ACME_EMAIL_REMEMBERED = false; MAY_SET_PRIVILEGED = false; }
  // What this machine has left, on the cards for the places that are on it. `up`
  // REFUSES without headroom, so the room belongs at the moment of choosing.
  ctx.api("/api/machine").then((cap) => {
    if (!cap || !cap.known) return;
    ctx.MACHINE_ROOM = cap;
    if (ctx.$("#create-dialog").open) ctx.renderDestinations();
  }).catch(() => {});
  // EVERY OPEN STARTS EMPTY. Only the presets were reset, so a second "+ New workspace"
  // came up holding the last create's name, port and image -- and with "If the name
  // already exists" on its default, Reuse it, Create quietly started (and re-seeded)
  // the earlier workspace instead of building the one on screen.
  ctx.$("#create-form").reset();
  ctx.syncCreateSeed();
  // These decide what CODE runs, where it listens and what it may do, and the server
  // refuses them from whoever `gui.create_policy` says. Shown to everyone -- members create
  // workspaces too -- and disabled with the reason when the policy keeps them to admins.
  // `context` is the place cards' business; `license` is the license row's (options.js).
  for (const name of PRIVILEGED_FIELDS) {
    if (name === "context" || name === "license") continue;
    const input = ctx.$("#create-form")[name];
    if (input && input.closest("label")) {
      input.closest("label").hidden = false;
      input.disabled = !MAY_SET_PRIVILEGED;
      if (!MAY_SET_PRIVILEGED) input.value = "";
    }
  }
  ctx.$("#adv-policy").hidden = MAY_SET_PRIVILEGED;
  ctx.initOptions(preset);
  syncBindHint();
  ctx.$("#create-dialog").showModal();
  ctx.startCreate({ dest, step: dest ? 2 : 1 });
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
  "seedChoices": { enumerable: true, get: () => seedChoices },
  "loadSeedChoices": { enumerable: true, get: () => loadSeedChoices },
  "seedRequest": { enumerable: true, get: () => seedRequest },
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
