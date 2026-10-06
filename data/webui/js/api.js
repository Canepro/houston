import { ctx } from "./shared.js";

// ---- the edge ---------------------------------------------------------------
// One Traefik serves every https name on the box. It is NOT a workspace, so it
// never appears in the grid and cannot be stopped from here -- but it holds :443
// for everyone, and something invisible that can take every name down at once is
// worse than one more chip.
let EDGE = null;
// Docker's last known state, so the home page can lead with it being down —
// nothing can start, stop or report while it is, and that outranks every other
// thing the page might say.
let DOCKER_OK = true;

async function refreshEdgeBadge() {
  const badge = ctx.$("#edge-badge");
  try { EDGE = await ctx.api("/api/edge"); }
  catch (_) { badge.hidden = true; return; }        // no gui extra / no permission
  if (!EDGE.installed) { badge.hidden = true; return; }

  // A route the edge cannot reach answers 502 rather than erroring, so it would
  // otherwise look like a broken workspace. Surfaced ahead of "running".
  const broken = (EDGE.routes || []).filter((r) => !r.reachable).length;
  const n = (EDGE.routes || []).length;
  badge.hidden = false;
  if (!EDGE.running) {
    badge.textContent = `edge: stopped`;
    badge.className = "chip down";
  } else if (broken) {
    badge.textContent = `edge: ${broken} unreachable`;
    badge.className = "chip down";
  } else {
    badge.textContent = `edge: ${n} name${n === 1 ? "" : "s"}`;
    badge.className = "chip up";
  }
}

function openEdge() {
  const body = ctx.$("#edge-body");
  body.innerHTML = "";
  if (!EDGE || !EDGE.installed) {
    body.append(ctx.el("p", { class: "kv" },
      "No edge yet — it starts with the first --https or --domain workspace."));
  } else {
    body.append(ctx.el("div", { class: "kv" },
      EDGE.running ? "Running — holds :80 and :443 for every https name"
                   : "STOPPED — every https name on this box is unreachable"));
    if (EDGE.domain) body.append(ctx.el("div", { class: "kv" }, `GUI name: ${EDGE.domain}`));
    if (!(EDGE.routes || []).length) {
      body.append(ctx.el("p", { class: "kv" }, "No names registered yet."));
    }
    for (const r of EDGE.routes || []) {
      // The KIND of route is worth saying: one is terminated here and one is not, and
      // a reader looking at this list is usually asking which.
      body.append(ctx.el("div", { class: "dcheck " + (r.reachable ? "ok" : "warn") },
        ctx.el("span", { class: "dmark" }, r.reachable ? "✓" : "!"),
        ctx.el("span", {}, `${r.host || r.name} → ${r.name}`
          + (r.passthrough ? "  (passed through to the cluster, not decrypted)" : "")
          + (r.reachable ? "" : "  (unreachable — answers 502)"))));
    }
    // Only a container-backed route is fixed by re-attaching; a passthrough has no
    // network to join, so advising it would send someone to restart a healthy edge.
    if ((EDGE.routes || []).some((r) => !r.reachable && !r.passthrough)) {
      body.append(ctx.el("p", { class: "banner warn" },
        "Run `houston edge restart` to re-attach them."));
    }
    // Certificates nothing points at. `down --volumes` removes a workspace's ROUTE
    // and walks past the certificate, which is keyed by hostname -- so a Let's
    // Encrypt certificate AND private key for a name you are finished with stays on
    // this disk. Amber, not red: the row is telling you something wants attention;
    // the button that destroys is the red one.
    const stale = EDGE.stale_certs || [];
    if (stale.length) {
      const many = stale.length > 1;
      body.append(ctx.el("p", { class: "banner warn" },
        `${stale.length} certificate${many ? "s" : ""} held with no route — `
        + (many ? "each is a certificate and private key"
                : "a certificate and private key")
        + " on this box for a name nothing serves."));
      for (const host of stale) {
        const row = ctx.el("div", { class: "dcheck warn" },
          ctx.el("span", { class: "dmark" }, "!"),
          ctx.el("span", {}, host));
        // Admin only, and ABSENT rather than disabled for everyone else -- the rule
        // this GUI uses everywhere: a control you cannot use should not be there to
        // wonder about.
        if (ctx.canAdmin()) {
          row.append(ctx.el("button", { class: "btn danger small", onclick: () => forgetHost(host) },
            "Delete"));
        }
        body.append(row);
      }
    }
  }
  if (!ctx.$("#edge-dialog").open) ctx.$("#edge-dialog").showModal();
}

async function forgetHost(host) {
  // The prompt names the private key on purpose. "Delete rc-rpro-test.example.org"
  // reads like removing a route, and it is removing a key that cannot be recovered.
  if (!confirm(`Delete ${host}?\n\nThis removes its route, its certificate and its `
             + `PRIVATE KEY, and its Let's Encrypt entry.\n\nThis cannot be undone.`)) {
    return;
  }
  try {
    const gone = await ctx.api(`/api/edge/hosts/${encodeURIComponent(host)}?confirm=true`,
                           { method: "DELETE" });
    // What actually went, not what was asked for -- the same reason the CLI reports
    // per kind. A restart happens only for an ACME deletion, and it is worth saying
    // because every other name on the box blinked.
    const bits = [];
    if (gone.routes && gone.routes.length) bits.push(`route ${gone.routes.join(", ")}`);
    if (gone.certificate) bits.push("certificate and key");
    if (gone.acme && gone.acme.length) bits.push(`Let's Encrypt entry (${gone.acme.join(", ")})`);
    ctx.toast(bits.length ? `${host}: removed ${bits.join(", ")}`
                      : `${host}: nothing here to remove`, "ok");
  } catch (e) {
    ctx.toast(`Could not delete ${host}: ${e.message}`);
  }
  // Re-read before re-rendering: the dialog is drawn from EDGE, and after a delete
  // that object is stale by exactly the row the user just acted on.
  await refreshEdgeBadge();
  await ctx.refreshClusterBadge();
  openEdge();
}

function render() {
  const grid = ctx.$("#repros");
  grid.innerHTML = "";
  const running = ctx.ALL_REPROS.filter((r) => r.state === "running").length;
  // With docker unreachable every state is "?", so "0 running" would be a claim we
  // cannot support (and #running-pill is styled green).
  const unknown = ctx.ALL_REPROS.length > 0 && ctx.ALL_REPROS.every((r) => r.state === "?");
  const pill = ctx.$("#running-pill");
  pill.textContent = unknown ? "state unknown" : `${running} running`;
  pill.className = "pill " + (unknown ? "unknown" : "running");
  ctx.$("#sb-count").textContent = `${ctx.ALL_REPROS.length} repro(s) · ` +
    (unknown ? "state unknown (docker unavailable)" : `${running} running`);
  ctx.$("#sb-refreshed").textContent = "Last refreshed: " + new Date().toLocaleTimeString();
  // `no-detail` HIDES THE ACTION PANE, and a cluster's own view has one. Without the second
  // clause this line -- which runs on the four-second poll -- put the class back four
  // seconds after the view was opened, so the build button and the permissions
  // documents disappeared while you were reading them. The identical mistake is
  // guarded two lines below for the pane's CONTENTS; this one governs whether the
  // column is displayed at all, and fixing only the other half looked correct in
  // every screenshot taken inside four seconds.
  ctx.$(".panes").classList.toggle(
    "no-detail", ctx.VIEW !== "cluster" && (ctx.VIEW !== "workspace" || !ctx.SELECTED));
  // render() runs on the four-second poll, so it must redraw the RAIL without
  // touching a stage it does not own. Activity and Scenarios paint themselves and
  // then stay put; anything else here reset them to home within four seconds of
  // opening, which is how the Scenarios page shipped in v0.40.0 and vanished
  // while you were reading it.
  if (ctx.VIEW === "home" && !ctx.SELECTED) ctx.renderHome();
  // A cluster's view paints its own pane and must keep it, for the reason the note above
  // gives about the stage: this line reset it within four seconds of opening, so the
  // build button and the permissions documents vanished while you were reading them.
  if (ctx.VIEW !== "workspace" && ctx.VIEW !== "cluster") ctx.$("#actpane").innerHTML = "";

  let list = ctx.ALL_REPROS.filter((r) =>
    (!ctx.view.filter || r.name.toLowerCase().includes(ctx.view.filter)) &&
    (!ctx.view.status || r.state === ctx.view.status) &&
    (ctx.view.scope !== "mine" || !ctx.ME || (r.owner || r.created_by) === ctx.ME));
  const key = ctx.view.sort;
  list.sort((a, b) => key === "port" ? a.host_port - b.host_port
    : String(a[key]).localeCompare(String(b[key])));

  if (!ctx.ALL_REPROS.length) grid.append(ctx.el("p", { class: "empty" }, "No workspaces yet. Start with “+ New workspace”."));
  else if (!list.length) grid.append(ctx.el("p", { class: "empty" }, "Nothing matches this filter."));

  // GROUPED BY WHAT IT WANTS FROM YOU. A flat list is fine with two workspaces and
  // is the wrong shape for a shared box running eight to twelve: "which one is
  // unhappy" was a question you answered by reading every row, and the unhappy one
  // could be anywhere in an alphabetical list.
  //
  // With docker unreachable every state is "?" -- there is nothing to distinguish, so
  // grouping would sort them into one bucket with a heading that says nothing.
  for (const [title, tone, rows] of unknown ? [["", "", list]] : railGroups(list)) {
    if (!rows.length) continue;
    // The heading is suppressed when there is only one group: with everything in one
    // state the rail-head pill above already says which, and a heading over the whole
    // list is a label for the thing it is inside.
    if (title && !unknown) {
      grid.append(ctx.el("div", { class: "rgrp" },
        ctx.el("span", { class: "rdot " + tone }),
        ctx.el("span", { class: "rgrp-t" }, title),
        ctx.el("span", { class: "rgrp-n" }, String(rows.length))));
    }
    for (const r of rows) grid.append(card(r));
  }
}

// Three buckets, in the order you need them. "Wants you" is not "not running": a
// stopped workspace is doing exactly what it was told, and a restart-looping one is
// not, so they cannot share a group without the group meaning nothing.
const RAIL_ORDER = [["Wants you", "warn"], ["Running", "ok"], ["Not running", "off"]];
function wantsYou(r) {
  // States nothing is going to fix on its own.
  if (["restarting", "dead", "paused"].includes(r.state)) return true;
  // Running, answering, and failing the healthcheck it sets for itself.
  if (r.state === "running" && ctx.healthClass(r) === "bad") return true;
  // Its https name resolves and answers 502, which looks like a broken workspace
  // rather than a broken route -- so the rail has to be the thing that says so.
  const route = ((EDGE && EDGE.routes) || []).find((x) => x.name === r.name);
  return !!(route && route.reachable === false);
}
function railGroups(list) {
  const buckets = [[], [], []];
  for (const r of list) {
    buckets[wantsYou(r) ? 0 : r.state === "running" ? 1 : 2].push(r);
  }
  const live = buckets.filter((b) => b.length).length;
  return RAIL_ORDER.map(([title, tone], i) =>
    [live > 1 ? title : "", tone, buckets[i]]);
}

// A row, not a card. The old card was 130px tall and carried six buttons; six
// workspaces meant 36 buttons on screen and 4.5 of them visible. This is 52px, has no
// buttons at all, and shows the whole name -- which is the thing anyone is actually
// scanning for. Everything you can DO lives in the stage, next to the workspace it
// acts on.
//
// One line was tried and reverted. It fits more rows, and it pays for them with the
// port, the owner and the scenario -- which is what people search a rail BY on a
// shared box. The grouping above is what "which one is unhappy" needed; the row did
// not have to shrink as well.
function card(r) {
  const busy = pendingOn(r.name);
  const state = busy ? "working" : ctx.stateClass(r.state || "?");
  const row = ctx.el("button", {
    class: "wrow",
    "data-state": state,
    "aria-current": r.name === ctx.SELECTED ? "true" : "false",
    title: r.name,
    onclick: () => ctx.selectRepro(r.name),
  });
  const r1 = ctx.el("span", { class: "r1" }, ctx.el("span", { class: "nm" }, r.name));
  if (r.default) r1.append(ctx.el("span", { class: "star", title: "used by CLI commands with no --name" }, "★"));
  r1.append(ctx.el("span", { class: "ver" }, r.rc_version || "?"));
  const bits = [r.preset, ":" + r.host_port, r.created_by].filter(Boolean);
  // Runtime is shown only when it is NOT the default. Compose is the overwhelming
  // majority, so labelling every row "docker" would be noise on the common case and
  // make the rare one harder to spot rather than easier. What matters is that a
  // Kubernetes workspace never looks like a Compose one: which commands refuse,
  // where the data lives and how to reach it all differ, and the list was the one
  // place the two were indistinguishable.
  if (r.runtime && r.runtime !== "docker") bits.push(r.runtime === "kubernetes" ? "k8s" : r.runtime);
  if (r.monitoring) bits.push("monitored");
  row.append(r1, ctx.el("span", { class: "meta" }, bits.join(" · ")));
  // The third line stays even under a group heading that names the same state: the
  // heading is a boundary you scroll past, this is on the row you are looking at --
  // and for the group that wants you it says WHY, which the heading cannot.
  row.append(ctx.el("span", { class: "r3" },
    ctx.el("span", { class: "wstate " + (busy ? "working" : ctx.stateClass(r.state)) },
      busy ? (BUSY_VERB[busy] || busy) : (r.state === "?" ? "state unknown" : r.state)),
    ctx.el("span", { class: "wage" }, railWhy(r) || r.uptime || "")));
  return row;
}

// What the state word does not say, on the rows where there is something: the reason
// this row is in the group that wants you. Empty everywhere else, where the age it
// replaces is the more useful thing.
function railWhy(r) {
  if (!wantsYou(r)) return "";
  const route = ((EDGE && EDGE.routes) || []).find((x) => x.name === r.name);
  const bits = [];
  if (r.state === "running" && ctx.healthClass(r) === "bad") bits.push(r.health || "unhealthy");
  if (route && route.reachable === false) bits.push("https 502");
  return bits.join(" · ");
}

const PENDING = new Map();
const BUSY_VERB = {
  Stop: "Stopping", Start: "Starting", Restart: "Restarting", Down: "Removing",
  "Make default": "Setting default", "API token": "Minting",
  "Check TLS": "Checking", Env: "Applying",
};
const pendingOn = (name) => PENDING.get(name) || "";

// One builder for the card and the detail panel so a pending action looks the
// same in both. `pending` is the label of whatever is running on this repro:
// every button is disabled while it is set, because these are compose commands
// against a single project and Restart on top of an in-flight Stop raced them.
function actionButton(label, fn, { cls = "", small = false, pending = "", title = "" } = {}) {
  const klass = "btn" + (small ? " small" : "") + (cls ? " " + cls : "");
  const attrs = title ? { title } : {};
  if (!pending) return ctx.el("button", { ...attrs, class: klass, onclick: () => fn() }, label);
  if (pending !== label) return ctx.el("button", { ...attrs, class: klass, disabled: "" }, label);
  return ctx.el("button", { ...attrs, class: klass + " working", disabled: "" },
    ctx.el("span", { class: "spin" }), (BUSY_VERB[label] || label) + "…");
}
const actBtn = (label, fn, cls = "", pending = "") =>
  stop(actionButton(label, fn, { cls, small: true, pending }));

// Run a slow synchronous action, keeping the UI honest about it from click to
// completion. The state lives in PENDING so both re-render paths (poll -> render,
// job callbacks -> renderDetail) redraw it instead of wiping it.
async function runAction(name, label, fn) {
  if (PENDING.has(name)) return;          // a second click while one is in flight
  PENDING.set(name, label);
  render();
  if (ctx.SELECTED === name) ctx.renderDetail();
  try { await fn(); }
  catch (e) { ctx.toast(e.message); }
  finally {
    PENDING.delete(name);
    await ctx.loadRepros();                   // re-renders with the real new state
    if (ctx.SELECTED === name) await ctx.refreshDetail({ force: true });
  }
}


// The action pane: everything you can do TO this workspace, grouped by intent.
//
// It used to be thirteen buttons in one row of the panel, in one weight -- "Open
// RC", which you press ninety times out of a hundred, sat next to "Capacity",
// which takes forty minutes, next to "Down", which destroys a customer
// reproduction. The row was read every single time because nothing in it was
// ranked.
//
// The grouping is not decoration, it is the teaching: "put data in it" explains
// what Seed does to somebody who never read the CLI's help. That only works if
// they can SEE it, which is why this is a pane and not a menu.
// The suggestion ladder, stated in order. Only ever the FIRST TWO that qualify, and
// every reason is a fact about THIS workspace rather than a guess about intent --
// guessing "next" wrongly is worse than not guessing, which is why nothing here reads
// a name, an age or a preset.
//
// Nothing is suggested for a workspace that is not running: what its state admits is
// "start it", which the panel's own action row and the triage block above both offer.
const NEXT_LADDER = [
  ["seed", (d) => !d.seed,
   "It has no sample data yet — no users, rooms or messages beyond the admin account."],
  ["call", () => true,
   "Send a REST request to this workspace and read the response here."],
  ["backup", (d) => !!d.seed,
   "It has data now, and a backup can be restored into a new workspace."],
];

function renderActionPane(d, busyLabel) {
  const pane = ctx.$("#actpane");
  pane.innerHTML = "";
  if (!ctx.canWrite()) {
    pane.append(ctx.el("p", { class: "apnote", title: ctx.READONLY_WHY },
      "You have the readonly role, so nothing here is available to you. "
      + "Opening the workspace and reading this panel are."));
    return;
  }
  const running = d.state === "running";
  // `on: false` means "this runtime refuses it". The load test and the capacity search
  // are Compose-only and the server says so with a 400 -- rendering them on a
  // Kubernetes workspace could only produce a red toast, which is the same reason the
  // logs and env tabs are kept off a readonly panel. Not "unimplemented": both would
  // be measuring the `kubectl port-forward` rather than Rocket.Chat.
  // See services/perf.require_compose_for_perf.
  const kube = d.runtime === "kubernetes";
  // ONE FLAT LIST, in the order the four headings used to impose. Four titled groups
  // over eleven items is a taxonomy, and a taxonomy is what you need when you do not
  // know what you are looking for -- but the question people arrive with is "what do I
  // do with this workspace now", and a heading called "Keep or move it" does not answer
  // it. The two that DO are lifted out above, with the reason they were chosen.
  const items = [
    { id: "seed", label: "Add sample data", fn: () => ctx.openSeed(d.name), ok: running },
    { id: "import", label: "Import settings", fn: () => ctx.openImport(d.name), ok: running },
    { id: "call", label: "Send an API call", fn: () => ctx.openCall(d.name), ok: running },
    { id: "pat", label: "PAT and Token", fn: () => ctx.doPat(d.name), ok: running },
    { id: "backup", label: "Back up now", fn: () => ctx.doBackup(d.name), ok: running },
    { id: "upgrade", label: "Upgrade version",
      fn: () => ctx.openUpgrade(d.name, d.rc_version), ok: running },
    // Named for the thing rather than for one of its parts: it attaches Prometheus,
    // Grafana, Loki and the exporters, and "stream to Grafana" described the last hop.
    { id: "monitor", label: d.monitoring ? "Detach monitoring" : "Attach monitoring",
      fn: () => ctx.doMonitor(d.name, !!d.monitoring), ok: running },
    { id: "loadtest", label: "Run a load test",
      fn: () => ctx.openPerf(d.name, d.monitoring), ok: running, on: !kube },
    { id: "capacity", label: "Find capacity", fn: () => ctx.openCap(d.name), ok: running,
      on: !kube },
    // Greyed until there is a public name. On Kubernetes it was hidden outright, on the
    // reasoning that `up --https` is refused there; but `--domain` gives a cluster
    // workspace a real certificate, and the TLS route answers for it.
    { id: "tls", label: "Check the certificate", fn: () => ctx.doTlsStatus(d.name),
      ok: running && !!d.public_url, on: !kube || !!d.public_url },
    { id: "default", label: "Use for CLI commands", fn: () => ctx.doDefault(d.name),
      ok: !d.is_default },
  ].filter((it) => it.on !== false);

  const byId = new Map(items.map((it) => [it.id, it]));
  const next = [];
  if (running && !busyLabel) {
    for (const [id, when, why] of NEXT_LADDER) {
      if (next.length === 2) break;
      const it = byId.get(id);
      if (it && it.ok && when(d)) next.push([it, why]);
    }
  }
  if (next.length) {
    pane.append(ctx.el("div", { class: "apgroup" }, "Next, probably"));
    const box = ctx.el("div", { class: "apnext" });
    // The label, and nothing else. The reason each one was chosen was a sentence under
    // it, and a sentence under a suggestion is a thing to read before you can act: the
    // heading already says these are suggestions, and the item says what it does.
    for (const [it] of next) {
      box.append(ctx.el("button", { class: "apn", onclick: it.fn }, ctx.el("b", {}, it.label)));
    }
    pane.append(box);
  }

  const rest = items.filter((it) => !next.some(([n]) => n === it.id || n.id === it.id));
  if (rest.length) {
    pane.append(ctx.el("div", { class: "apgroup" },
      next.length ? "Everything else" : "What you can do with it"));
    const listEl = ctx.el("div", { class: "aplist" });
    for (const it of rest) {
      const b = ctx.el("button", { onclick: it.fn }, it.label);
      if (!it.ok || busyLabel) b.disabled = true;
      listEl.append(b);
    }
    pane.append(listEl);
  }
  if (kube) {
    pane.append(ctx.el("p", { class: "apnote" },
      "Load testing and the capacity search are Compose-only: a Kubernetes "
      + "workspace is reached through a port-forward, which would be what the "
      + "numbers measured."));
  }
  if (!running) {
    pane.append(ctx.el("p", { class: "apnote" },
      `Most of these need the workspace running. It is ${d.state === "?" ? "unreachable" : d.state}.`));
  }
  // Pinned to the bottom, not trailing the last group: it is not the eleventh
  // item on a menu, it is the thing you have to travel to.
  const danger = ctx.el("div", { class: "apdanger" });
  const btn = ctx.el("button", { onclick: () => ctx.doDown(d.name) }, "Take this workspace down");
  if (busyLabel) btn.disabled = true;
  danger.append(btn, ctx.el("p", {},
    (kube ? "Uninstalls its release and stops the port-forward. "
          : "Removes its containers. ")
    + "You are asked separately before any data is deleted."));
  pane.append(danger);
}



Object.defineProperties(ctx, {
  "EDGE": { enumerable: true, get: () => EDGE, set: value => { EDGE = value; } },
  "DOCKER_OK": { enumerable: true, get: () => DOCKER_OK, set: value => { DOCKER_OK = value; } },
  "refreshEdgeBadge": { enumerable: true, get: () => refreshEdgeBadge },
  "openEdge": { enumerable: true, get: () => openEdge },
  "forgetHost": { enumerable: true, get: () => forgetHost },
  "render": { enumerable: true, get: () => render },
  "RAIL_ORDER": { enumerable: true, get: () => RAIL_ORDER },
  "wantsYou": { enumerable: true, get: () => wantsYou },
  "railGroups": { enumerable: true, get: () => railGroups },
  "card": { enumerable: true, get: () => card },
  "railWhy": { enumerable: true, get: () => railWhy },
  "PENDING": { enumerable: true, get: () => PENDING },
  "BUSY_VERB": { enumerable: true, get: () => BUSY_VERB },
  "pendingOn": { enumerable: true, get: () => pendingOn },
  "actionButton": { enumerable: true, get: () => actionButton },
  "actBtn": { enumerable: true, get: () => actBtn },
  "runAction": { enumerable: true, get: () => runAction },
  "NEXT_LADDER": { enumerable: true, get: () => NEXT_LADDER },
  "renderActionPane": { enumerable: true, get: () => renderActionPane },
});
export { EDGE, DOCKER_OK, refreshEdgeBadge, openEdge, forgetHost, render, RAIL_ORDER, wantsYou, railGroups, card, railWhy, PENDING, BUSY_VERB, pendingOn, actionButton, actBtn, runAction, NEXT_LADDER, renderActionPane };
