import { ctx } from "./shared.js";

// ---- where a workspace runs: the places, shared by Create and the Clusters page ----
// Populated from /api/settings, never from a list written here: two places deciding
// the same thing is how the dialog ends up offering a combination the service refuses.
let RUNTIMES = [];

const RUNTIME_LABEL = { docker: "Docker", kubernetes: "Kubernetes" };
function runtimeLabel(name) { return RUNTIME_LABEL[name] || name; }

// What the ARRANGEMENT builds, said under the control that chooses it. What a runtime
// cannot do is said once, by the absence line in More options, which is generated from
// the server's refusal registry.
const DEPLOYMENT_NOTE = {
  monolith: "One Rocket.Chat process.",
  "multi-instance": "Several Rocket.Chat containers behind a load balancer.",
  microservices: "Rocket.Chat plus presence, ddp-streamer, account, authorization "
    + "and stream-hub, each its own deployment.",
};
// The words on the Shape control. The VALUE is still the deployment name the CLI
// takes; only what a person reads is plain.
const SHAPE_LABEL = {
  docker: { monolith: "One instance", "multi-instance": "Several instances" },
  kubernetes: { microservices: "Microservices", monolith: "One pod" },
};
const DEPLOYMENT_LABEL = { monolith: "monolith", "multi-instance": "multi-instance", microservices: "microservices" };

function fmtGb(mb) {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

// The rows behind the cluster choice: the ones the GUI shows (local and AWS), and ALL
// of them -- the second only so "is the box default one the GUI cannot show" can be
// answered, which decides whether an empty context can be described truthfully.
let KUBE_CLUSTERS = [];
let ALL_KUBE_CLUSTERS = [];
// This machine's memory, from /api/machine: room per runtime, shown on the cards for
// the places that are on this machine and nowhere else.
let MACHINE_ROOM = null;

function clusterLabel(c) {
  // `short` and `region` come from the SERVER: an EKS context is sixty-odd characters
  // of ARN, and the name and region are the two a person needs.
  const name = (c && c.short) || (c && c.context) || "";
  const region = (c && c.region) || "";
  return region ? `${name} (${region})` : name;
}

const PLACE_ICON = {
  docker: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="10" width="18" height="9" rx="2"/><path d="M7 10V6h4v4M11 10V6h4v4"/></svg>',
  k8s: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z"/><circle cx="12" cy="12" r="3"/></svg>',
  aws: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.2 4.5 4.5 0 0 0 7 18z"/></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
};
const icon = (name) => ctx.el("span", { class: "ico", html: PLACE_ICON[name] || "" });
const plural = (n, word) => `${n === 0 ? "No" : n} ${word}${n === 1 ? "" : "s"}`;
const perDay = (st) => (st && st.cost && st.cost.usd_hr ? st.cost.usd_hr * 24 : null);

// A cluster's state in the words both pages use, and the pill colour that goes with it.
function placeState(st) {
  // "Reading…" only while a read is in flight: after a failed one it would never end.
  if (!st) return ctx.CLSTATE && ctx.CLSTATE.overviewError ? ["off", "Not read"] : ["off", "Reading…"];
  if (st.gone) return ["off", "Gone in AWS"];
  if (st.reachable) return ["ok", "Running"];
  if (st.reach_status === "denied") return ["warn", "Refusing"];
  return ["warn", "Not answering"];
}

// What makes an EKS cluster want somebody, as one line. Not cost: a cluster you are
// deliberately paying for is doing its job. Idle AND billing is the exception, because
// that is money buying nothing.
function placeWarn(st) {
  if (!st || st.gone) return "";
  if (!st.reachable) return st.reach_why ? `${st.reach_why}.` : "";
  // A reminder wants you once it is DUE, not three days out: a build given a short
  // reminder was flagged the minute it was ready, above the DNS record it actually needed.
  const d = st.expires_in_days;
  if (typeof d === "number" && d < 0) return `Past its reminder date ${-d} day${d === -1 ? "" : "s"} ago. It keeps billing until someone deletes it.`;
  if (d === 0) return "Its reminder date is today. It keeps billing until someone deletes it.";
  // Before "holds no workspaces": a new cluster holds none BECAUSE its names do not answer
  // yet, so the record is the next step, not deleting it.
  if (st.zone && st.ready && st.ready.dns_answers === false) return `Public names under ${st.zone} do not answer yet.`;
  const day = perDay(st);
  if (day && st.made_by_houston === true && Array.isArray(st.workspaces) && !st.workspaces.length) {
    return `Holds no workspaces and still bills ~$${day.toFixed(2)} a day. Delete it when you are done.`;
  }
  return "";
}

function roomFor(runtime) {
  const cap = MACHINE_ROOM;
  if (!cap || !cap.known) return "";
  if (runtime === "docker") return `room for ${cap.room} more`;
  const spec = RUNTIMES.find((r) => r.name === "kubernetes");
  const dep = spec ? spec.default_deployment : "microservices";
  const n = (cap.room_by_runtime || {})[`kubernetes-${dep}`];
  return typeof n === "number" ? `room for ${n} more` : "";
}

// Where a workspace with no cluster named lands. The server tries its saved default first,
// then the cluster `up` picks on its own -- houston's own kind, else whatever kubectl points
// at if it answers -- which is what /api/kubernetes reports as `context`. Null when neither
// is known and answering. Reading only the saved default, a member was told "Unavailable"
// on a box whose k3s took every such workspace (measured on a k3s playground).
function emptyContextRow() {
  const def = ALL_KUBE_CLUSTERS.find((c) => c.is_default);
  if (def) return def;
  const k = ctx.KUBE;
  if (!k || !k.reachable || !k.context) return null;
  return ALL_KUBE_CLUSTERS.find((c) => c.context === k.context) || null;
}

// Every place a workspace can go, as data: the Clusters page and step 1 of Create both
// draw these, so the two can never describe the same place differently.
function places({ inventory = false } = {}) {
  const status = (ctx.CLSTATE && ctx.CLSTATE.status) || {};
  const k = ctx.KUBE;
  const here = [];
  const aws = [];
  const repros = ctx.ALL_REPROS || [];
  if (!RUNTIMES.length || RUNTIMES.some((r) => r.name === "docker")) {
    const n = repros.filter((r) => (r.runtime || "docker") === "docker").length;
    here.push({ key: "docker", runtime: "docker", context: "", ico: "docker", nm: "Docker", wh: "On this machine",
      pill: ctx.DOCKER_OK === false ? ["warn", "Not answering"] : ["ok", "Ready"],
      ds: ctx.DOCKER_OK === false ? "Docker is not answering on the server. houston doctor says why."
        : "The quickest way to run Rocket.Chat. Right for most workspaces.",
      facts: [plural(n, "workspace"), roomFor("docker")].filter(Boolean), usable: ctx.DOCKER_OK !== false });
  }
  const kube = !RUNTIMES.length || RUNTIMES.some((r) => r.name === "kubernetes");
  if (!kube) return { here, aws, hiddenDefault: false };
  const def = ALL_KUBE_CLUSTERS.find((c) => c.is_default);
  const hiddenDefault = !!def && def.where === "elsewhere";
  const may = inventory || ctx.MAY_SET_PRIVILEGED === true;
  const clusterCard = (c) => {
    const st = status[c.context];
    const local = c.where === "local";
    const held = st && Array.isArray(st.workspaces) ? plural(st.workspaces.length, "workspace") : "";
    const dist = (st && st.distribution) || (c.ours ? "kind" : "");
    const day = perDay(st);
    return { key: (local ? "k8s:" : "eks:") + c.context, runtime: "kubernetes", context: c.context,
      ico: local ? "k8s" : "aws", nm: local ? "Kubernetes" : (c.short || c.context),
      wh: local ? ["On this machine", dist, c.short || c.context].filter(Boolean).join(" · ")
        : `Amazon EKS · ${(st && st.region) || c.region || "?"}`,
      pill: placeState(st), cost: local ? null : day, costKnown: !local && !!st,
      ds: local ? "Real pods and Helm charts on this computer. Use it when what you are testing depends on Kubernetes." : "",
      facts: [held, local ? roomFor("kubernetes") : clNodesText(st)].filter(Boolean),
      warn: local ? "" : placeWarn(st), usable: !st || (!!st.reachable && !st.gone), row: c };
  };
  if (!may) {
    // The box policy keeps the cluster choice to admins, so the form cannot send one: one
    // card, "the server's default" -- and only where it can be said where that goes. A
    // default the GUI does not show, or none and no kind to make one, is said, not offered.
    const lands = emptyContextRow();
    const known = !!lands && lands.where !== "elsewhere";
    const makes = !lands && k && k.can_provision;
    // With no saved default, where it lands is what the probe says -- and until the probe
    // has answered that is unknown, not "Unavailable".
    const reading = !lands && !ctx.KUBE_READ;
    const card = { key: "k8s-default", runtime: "kubernetes", context: "", ico: lands && lands.where === "aws" ? "aws" : "k8s",
      nm: "Kubernetes", wh: known ? `This server's default · ${clusterLabel(lands)}` : "This server's default cluster",
      pill: known || makes ? ["ok", "Ready"] : reading ? ["off", "Reading…"] : ["off", "Unavailable"],
      ds: known || makes ? "Choosing a cluster is kept to admins on this server, so this uses its default."
        : reading ? "Reading this server's Kubernetes…"
        : "Choosing a cluster is kept to admins on this server, and its default is set from the command line.",
      facts: [], usable: !!(known || makes) };
    if (lands && lands.where === "aws") aws.push(card); else here.push(card);
    return { here, aws, hiddenDefault: !!lands && lands.where === "elsewhere", limited: true };
  }
  const locals = KUBE_CLUSTERS.filter((c) => c.where === "local");
  for (const c of locals) here.push(clusterCard(c));
  // The Clusters page draws before its list arrives, and a list it could not read is no list:
  // neither is "no cluster on this machine" -- the card said so about a running k3s.
  const unread = inventory && !locals.length && !ctx.CLUSTERS;
  // A list that WAS read but from a kubeconfig the server could not open is no list
  // either: a `chmod 000` on a running k3s's config was shown as "No cluster on this
  // machine, and kind is not installed", while the server had sent the reason.
  const unreadable = !locals.length && ctx.CLUSTERS && ctx.CLUSTERS.unreadable;
  if (unreadable) {
    here.push({ key: "k8s-none", runtime: "kubernetes", context: "", ico: "k8s", nm: "Kubernetes", wh: "On this machine",
      pill: ["warn", "Unreadable"], facts: [], usable: false,
      ds: `This machine's kubeconfig could not be read: ${unreadable}` });
  } else if (unread) {
    const why = ctx.CLSTATE && ctx.CLSTATE.listError;
    here.push({ key: "k8s-none", runtime: "kubernetes", context: "", ico: "k8s", nm: "Kubernetes", wh: "On this machine",
      pill: why ? ["warn", "Not answering"] : ["off", "Reading…"], facts: [], usable: false,
      ds: why ? `This machine's Kubernetes contexts could not be read: ${why}. houston doctor says why.`
        : "Reading this machine's Kubernetes contexts…" });
  } else if (!locals.length) {
    // AN EMPTY CONTEXT IS OFFERED ONLY WHEN IT CAN BE SAID WHERE IT GOES. The server
    // resolves "" to the box default first, so with a default set -- a remote cluster
    // the GUI does not show, or an EKS one -- "a local cluster will be created" would be
    // a false sentence about a real workspace.
    const canMake = k && k.can_provision && !def;
    if (canMake) {
      here.push({ key: "k8s-new", runtime: "kubernetes", context: "", ico: "k8s", nm: "Kubernetes", wh: "On this machine",
        pill: ["off", "Not set up yet"], facts: [roomFor("kubernetes")].filter(Boolean), usable: true,
        ds: "Houston sets up a local cluster the first time you create a Kubernetes workspace: about 3 minutes and 600 MB of memory." });
    } else {
      // Whether kind could make one is the probe's answer; before it, nothing is known.
      const reading = !def && !ctx.KUBE_READ;
      here.push({ key: "k8s-none", runtime: "kubernetes", context: "", ico: "k8s", nm: "Kubernetes", wh: "On this machine",
        pill: ["off", reading ? "Reading…" : k === null ? "Not checked" : "Unavailable"], facts: [], usable: false,
        ds: def ? "No cluster on this machine. This server's default cluster is set elsewhere, so a local one is not made from here."
          : reading ? "Reading this machine's Kubernetes…"
          : k && k.tools_ready ? "No cluster on this machine, and kind is not installed to make one. houston doctor shows what is missing."
          : "Needs kubectl and helm on the server. houston doctor shows what is missing." });
    }
  }
  for (const c of KUBE_CLUSTERS.filter((x) => x.where === "aws")) aws.push(clusterCard(c));
  return { here, aws, hiddenDefault };
}

function clNodesText(st) {
  const shapes = st && st.instance_types ? Object.entries(st.instance_types) : [];
  return shapes.length ? shapes.map(([t, n]) => `${n} × ${t || "unlabelled"}`).join(", ") : "";
}

// One place, as a card body: the same markup on the Clusters page and in Create.
function placeBody(p) {
  const out = [ctx.el("div", { class: "ph" }, icon(p.ico),
    ctx.el("div", {}, ctx.el("div", { class: "nm" }, p.nm), ctx.el("div", { class: "wh" }, p.wh)))];
  out.push(ctx.el("div", {}, ctx.el("span", { class: `pill ${p.pill[0]}` }, p.pill[1])));
  if (p.cost !== null && p.cost !== undefined) {
    out.push(ctx.el("div", { class: "cost" }, `~$${p.cost.toFixed(2)} `, ctx.el("small", {}, "a day" + (p.lastKnown ? ", last known" : ""))));
  } else if (p.costKnown === false && p.ico === "aws") {
    out.push(ctx.el("div", { class: "cost" }, ctx.el("small", {}, "bills by the hour")));
  }
  if (p.ds) out.push(ctx.el("p", { class: "ds" }, p.ds));
  if (typeof p.progress === "number") out.push(ctx.el("div", { class: "progress" }, ctx.el("i", { style: `width:${p.progress}%` })));
  if (p.facts && p.facts.length) out.push(ctx.el("div", { class: "facts" }, ...p.facts.map((f) => ctx.el("span", {}, f))));
  if (p.warn) out.push(ctx.el("div", { class: "warnline" }, `▲ ${p.warn}`));
  return out;
}

// ---- Create a workspace: step 1, where it runs -----------------------------------
let DEST = "";            // the chosen place's key
let CREATE_STEP = 1;
let cardsAskedForOverview = false;

function destFor(key) {
  const { here, aws } = places();
  return [...here, ...aws].find((p) => p.key === key) || null;
}

function zoneHead(title, tag, money) {
  return ctx.el("div", { class: "zone-h" }, ctx.el("h2", {}, title),
    ctx.el("span", { class: "tag" + (money ? " money" : "") }, tag));
}

function renderDestinations() {
  const box = ctx.$("#dest-cards");
  if (!box) return;
  const { here, aws, hiddenDefault, limited } = places();
  const all = [...here, ...aws];
  if (!all.some((p) => p.key === DEST && p.usable)) DEST = (all.find((p) => p.usable) || { key: "" }).key;
  const pick = (p) => {
    const input = ctx.el("input", { type: "radio", name: "dest", value: p.key, "aria-label": `${p.nm}, ${p.wh}` });
    input.checked = p.key === DEST;
    input.disabled = !p.usable;
    input.addEventListener("change", () => pickDest(p.key));
    return ctx.el("label", { class: "pcard place", "data-dest": p.key }, input, ctx.el("span", { class: "radio" }), ...placeBody(p));
  };
  box.innerHTML = "";
  box.append(zoneHead("On this machine", "Free"), ctx.el("div", { class: "places" }, ...here.map(pick)));
  const awsCards = aws.map(pick);
  if (ctx.canAdmin() && !limited) {
    awsCards.push(ctx.el("button", { type: "button", class: "pcard place add click", "data-dest": "add",
      onclick: () => { ctx.$("#create-dialog").close(); ctx.openEksSetup(); } },
      icon("plus"), ctx.el("div", { class: "nm" }, aws.length ? "Add an EKS cluster" : "Set up Amazon EKS"),
      ctx.el("p", { class: "ds" }, "Opens the guided setup. This workspace waits.")));
  } else if (!aws.length) {
    awsCards.push(ctx.el("div", { class: "pcard place muted" }, ctx.el("div", { class: "nm" }, "Amazon EKS isn't set up"),
      ctx.el("p", { class: "ds" }, limited ? "Choosing a cluster is kept to admins on this server."
        : "An admin sets it up on the Clusters page.")));
  }
  box.append(zoneHead("In AWS", "Costs money", true), ctx.el("div", { class: "places" }, ...awsCards));
  if (hiddenDefault) {
    box.append(ctx.el("p", { class: "hint" }, "Other Kubernetes clusters on this server are used from the command line (",
      ctx.el("code", {}, "--context"), ")."));
  }
  applyDest();
  // What a cluster card says -- running, and for EKS what it costs -- comes from the
  // overview; ask for it once if a card is still without it. Not only for EKS: a local
  // k3s card said "Reading…" for as long as the dialog stayed open.
  if (!cardsAskedForOverview && ctx.loadClusterOverview && !(ctx.CLSTATE && ctx.CLSTATE.overview)
      && KUBE_CLUSTERS.length) {
    cardsAskedForOverview = true;
    ctx.loadClusterOverview().then((ov) => { if (ov && CREATE_STEP === 1 && ctx.$("#create-dialog").open) renderDestinations(); }).catch(() => {});
  }
}

function pickDest(key) {
  DEST = key;
  applyDest();
}

// The chosen place into the two fields the form sends, and what choosing it means.
function applyDest() {
  const p = destFor(DEST);
  const rt = ctx.$("#runtime-value");
  const csel = ctx.$("#context-select");
  if (p) {
    if (rt.value !== p.runtime) {
      rt.value = p.runtime;
      // The new runtime's DEFAULT arrangement, unconditionally: `--runtime k8s` on the
      // CLI defaults to microservices, and keeping Compose's monolith would diverge.
      const spec = RUNTIMES.find((r) => r.name === p.runtime);
      ctx.$("#deployment-value").value = spec ? spec.default_deployment : "";
    }
    if (csel) {
      if (p.context && ![...csel.options].some((o) => o.value === p.context)) {
        csel.append(ctx.el("option", { value: p.context }, p.context));
      }
      csel.value = p.context;
    }
  }
  const note = ctx.$("#dest-note");
  if (!note) return;
  note.innerHTML = "";
  note.className = "callout";
  if (p && p.ico === "aws") {
    note.classList.add("money");
    note.append("▲ ", ctx.el("b", {}, p.nm), ` is shared and costs ${p.cost ? `about ~$${p.cost.toFixed(2)} a day` : "money by the hour"}`
      + " whether or not this workspace runs. Deleting the workspace doesn't stop the charge.");
    note.hidden = false;
  } else if (p && p.key === "k8s-new") {
    note.classList.add("info");
    note.append("Houston sets up a local Kubernetes cluster first (about 3 minutes), then creates the workspace on it.");
    note.hidden = false;
  } else note.hidden = true;
}

function whereText(p) {
  if (!p) return "";
  if (p.ico === "aws") return `${p.nm} · Amazon EKS`;
  if (p.key === "docker") return "Docker · this machine";
  if (p.key === "k8s-new") return "Kubernetes · a new local cluster";
  if (p.key === "k8s-default") return "Kubernetes · this server's default";
  const rest = p.wh.replace(/^On this machine( · )?/u, "");
  return `Kubernetes${rest ? ` · ${rest}` : ""} · this machine`;
}

// ---- Create a workspace: the steps ----------------------------------------------
function setCreateStep(n, back = false) {
  CREATE_STEP = n;
  for (const i of [1, 2, 3]) { const s = ctx.$(`#create-step-${i}`); if (s) s.hidden = i !== n; }
  const sec = ctx.$(`#create-step-${n}`);
  if (sec) { sec.classList.remove("anim", "back"); void sec.offsetWidth; sec.classList.add("anim"); if (back) sec.classList.add("back"); }
  const steps = ctx.$("#create-steps");
  steps.innerHTML = "";
  ["Where it runs", "Details"].forEach((label, i) => {
    const at = i + 1;
    const cls = n === 3 || at < n ? "done" : at === n ? "on" : "";
    if (i) steps.append(ctx.el("span", { class: "ln" }));
    steps.append(ctx.el("span", { class: cls }, ctx.el("i", {}, cls === "done" ? "✓" : String(at)), label));
  });
  const show = (id, on) => { const b = ctx.$(id); if (b) b.hidden = !on; };
  show("#create-back", n === 2);
  show("#create-cancel", n !== 2);
  ctx.$("#create-cancel").textContent = n === 3 ? "Close" : "Cancel";
  show("#create-next", n === 1);
  show("#create-submit", n === 2);
  show("#create-open-ws", false);
  show("#create-open-rc", false);
  show("#create-stop", false);         // streamJob offers it once the job says it may stop
  const hint = ctx.$("#create-foot-hint");
  const p = destFor(DEST);
  if (n === 1) hint.textContent = "Next: the Rocket.Chat version and what to set up.";
  else if (n === 2) hint.textContent = createSummaryLine();
  else hint.textContent = "You can close this; the workspace keeps starting and shows in the list.";
  if (n === 2) {
    const sum = ctx.$("#create-summary");
    sum.innerHTML = "";
    sum.append("Runs on ", ctx.el("b", {}, whereText(p)));
    if (p && p.ico === "aws" && p.cost) sum.append(` · ~$${p.cost.toFixed(2)}/day, shared`);
    renderRuntimeAxes();
    syncHttpsFields();
    // The place decides which presets it can take: one with no Kubernetes adapter is not
    // offered on Kubernetes.
    ctx.renderOptions();
  }
  const focus = n === 2 ? ctx.$("#create-form").version : sec && sec.querySelector(".wzd-q");
  if (focus) focus.focus({ preventScroll: true });
  ctx.$("#create-body").scrollTop = 0;
}

function createSummaryLine() {
  const f = ctx.$("#create-form");
  return [f.version.value.trim(), ctx.optionsPresetText() || "default", whereText(destFor(DEST))].filter(Boolean).join(" · ");
}

// The arrangement control, for the chosen runtime, and the fields that follow it.
function renderRuntimeAxes() {
  const rt = ctx.$("#runtime-value").value || (RUNTIMES[0] && RUNTIMES[0].name) || "docker";
  const spec = RUNTIMES.find((r) => r.name === rt);
  const seg = ctx.$("#deployment-seg");
  seg.innerHTML = "";
  const deployments = spec ? spec.deployments : [];
  if (!deployments.includes(ctx.$("#deployment-value").value)) {
    ctx.$("#deployment-value").value = spec ? spec.default_deployment : "";
  }
  for (const d of deployments) {
    seg.append(ctx.el("button", { type: "button", "data-deployment": d,
      "aria-pressed": String(ctx.$("#deployment-value").value === d), onclick: () => pickDeployment(d) },
      (SHAPE_LABEL[rt] || {})[d] || d));
  }
  ctx.$("#runtime-hint").textContent = DEPLOYMENT_NOTE[ctx.$("#deployment-value").value] || "";
  // The one control a runtime ADDS: whether this workspace's MongoDB requires a password.
  const extra = ctx.$("#runtime-extra");
  const ticked = !!(ctx.$("#mongo-operator") && ctx.$("#mongo-operator").checked);
  extra.innerHTML = "";
  if (rt === "kubernetes") {
    const box = ctx.el("input", { type: "checkbox", name: "mongo_operator", id: "mongo-operator" });
    box.checked = ticked;
    extra.append(ctx.el("label", {}, box, " MongoDB via the official operator (SCRAM)"));
  }
  syncAdvancedForRuntime(spec);
  syncDeploymentFields();
}

function pickRuntime(name) {
  // Kept for callers that name a runtime rather than a place: the first usable place
  // of that runtime.
  const { here, aws } = places();
  const p = [...here, ...aws].find((x) => x.runtime === name && x.usable);
  if (p) pickDest(p.key);
  renderRuntimeAxes();
}

function pickDeployment(name) {
  ctx.$("#deployment-value").value = name;
  renderRuntimeAxes();
  ctx.$("#create-foot-hint").textContent = createSummaryLine();
}

const ADV_GONE_LABEL = {
  https: "HTTPS", domain: "a public domain",
  fresh: "rebuild and DELETE data",
};

function runsOnThisMachine() {
  const p = destFor(DEST);
  if (p) return p.ico !== "aws";
  const csel = ctx.$("#context-select");
  const chosen = csel && csel.value ? KUBE_CLUSTERS.find((c) => c.context === csel.value) : null;
  return !chosen || !chosen.billable;
}

function syncLocalCaOption() {
  // "Local certificate" cannot work on a cluster that is not on this machine: it would
  // copy houston's CA PRIVATE KEY into somebody else's cluster, which the server refuses
  // with GATE_UNAPPROVED_CLUSTER. Removed rather than left to be refused -- but only
  // when we positively know, so uncertainty keeps a working choice.
  const mode = ctx.$("#https-mode");
  if (!mode) return;
  const here = runsOnThisMachine();
  const has = [...mode.options].some((o) => o.value === "local");
  if (!here && has) {
    if (mode.value === "local") { mode.value = ""; }
    [...mode.options].find((o) => o.value === "local").remove();
    syncHttpsFields();
  } else if (here && !has) {
    mode.append(ctx.el("option", { value: "local" },
      "Local certificate: no domain needed (run houston trust-ca once)"));
  }
}

// The cluster this create goes to, or null for Docker.
function chosenCluster() {
  const csel = ctx.$("#context-select");
  if (!csel) return null;
  return csel.value
    ? KUBE_CLUSTERS.find((c) => c.context === csel.value) || null
    : (ctx.$("#runtime-value").value === "kubernetes" ? KUBE_CLUSTERS.find((c) => c.is_default) || null : null);
}

// The zone the SERVER will name this workspace from, or "". The server defaults
// <name>.<zone> only for a cluster named in the request -- an empty context is the box
// default, which it does not -- and reads the zone from THIS box's build note, which a
// cluster built elsewhere and connected here does not have. The dialog promising a name
// in either case sent a request the server answered without one.
function chosenZone() {
  const csel = ctx.$("#context-select");
  const chosen = chosenCluster();
  if (!csel || !csel.value || !chosen || chosen.made_by_houston !== true) return "";
  return ((ctx.CLSTATE && ctx.CLSTATE.status[chosen.context]) || {}).zone || "";
}

// ON A CLUSTER WITH A DNS ZONE EVERY NEW WORKSPACE GETS A PUBLIC NAME: the server fills in
// <name>.<zone> when no domain is typed, and that name is served by Let's Encrypt, which
// needs a contact email. "Off" was offered there and the create then failed on the email
// nobody was asked for; it goes, Let's Encrypt is chosen, and the domain becomes optional.
let OFF_OPTION = null;
let ZONE_CHOSE_ACME = false;
function syncZoneHttps(zone) {
  const mode = ctx.$("#https-mode");
  if (!mode) return;
  const domain = ctx.$("#create-form") && ctx.$("#create-form").domain;
  const off = [...mode.options].find((o) => o.value === "");
  const acme = [...mode.options].some((o) => o.value === "acme");
  if (zone && acme) {
    // Read BEFORE removing it: removing the selected option makes the browser select the
    // first one left, Let's Encrypt, so "was it ours to change" could never be answered.
    const wasOther = mode.value !== "acme";
    if (off) { OFF_OPTION = off; off.remove(); }
    if (wasOther) { mode.value = "acme"; ZONE_CHOSE_ACME = true; }
    if (domain) domain.placeholder = `leave empty for <name>.${zone}`;
  } else {
    if (!off) mode.prepend(OFF_OPTION || ctx.el("option", { value: "" }, "Off: plain http://localhost:PORT"));
    if (ZONE_CHOSE_ACME) { mode.value = ""; ZONE_CHOSE_ACME = false; }
    if (domain) domain.placeholder = "rc1.example.com";
  }
  syncHttpsFields();
}

// What a managed cluster means for how the workspace is REACHED, said in Access where
// that is decided. The money was said in step 1, where the cluster was chosen.
function syncClusterNote() {
  syncLocalCaOption();
  syncZoneHttps(chosenZone());
  const note = ctx.$("#cluster-note");
  const csel = ctx.$("#context-select");
  if (!note || !csel) return;
  const chosen = chosenCluster();
  if (!chosen || !chosen.billable) { note.hidden = true; return; }
  const domain = ctx.$("#create-form").domain;
  const hasDomain = !!(domain && domain.value.trim());
  note.hidden = false;
  note.innerHTML = "";
  // One load balancer per cluster, made by Prepare: every public name goes through it.
  note.append("A workspace on this cluster adds an EBS volume. Its public name goes through the cluster's "
    + "load balancer, which is already there.");
  const zone = chosenZone();
  if (!hasDomain && zone) {
    note.append(ctx.el("br", {}), `Its public name is <name>.${zone} unless you type a domain below. `
      + "Let's Encrypt gives it a certificate, so it needs a contact email once.");
  } else if (!hasDomain) {
    note.append(ctx.el("br", {}), "Without a domain it is reachable only by a port-forward from the "
      + "server: tied to a pod, gone when it restarts, one person at a time. ");
    note.append(ctx.el("button", { type: "button", class: "btn sm",
      onclick: () => {
        const mode = ctx.$("#https-mode");
        if (mode && [...mode.options].some((o) => o.value === "acme")) { mode.value = "acme"; syncHttpsFields(); }
        const d = ctx.$("#create-form").domain;
        if (d) { d.scrollIntoView({ block: "center" }); d.focus(); }
      } }, "Set a domain"));
  }
}

function syncAdvancedForRuntime(spec) {
  const gone = new Set(((spec && spec.unsupported) || []).map((u) => u.field));
  // HTTPS goes entirely only when HTTPS itself is refused; Kubernetes serves --https
  // through the chart's Ingress and cannot do --domain, so only that mode goes.
  const https = ctx.$("#create-https-block");
  if (https) https.hidden = gone.has("https");
  syncClusterNote();
  const mode = ctx.$("#https-mode");
  if (mode) {
    const has = [...mode.options].some((o) => o.value === "acme");
    if (gone.has("domain") && has) {
      if (mode.value === "acme") mode.value = "";
      [...mode.options].find((o) => o.value === "acme").remove();
      syncHttpsFields();
    } else if (!gone.has("domain") && !has) {
      mode.append(ctx.el("option", { value: "acme" }, "Let's Encrypt: a domain that already points here"));
    }
    syncLocalCaOption();
  }
  // `fresh` is ONE OPTION of the existing-name select: reuse and force work on both
  // runtimes, so the option goes and the control stays.
  const existing = ctx.$("#create-form").existing;
  if (existing) {
    const has = [...existing.options].some((o) => o.value === "fresh");
    if (gone.has("fresh") && has) {
      if (existing.value === "fresh") existing.value = "reuse";
      [...existing.options].find((o) => o.value === "fresh").remove();
    } else if (!gone.has("fresh") && !has) {
      existing.append(ctx.el("option", { value: "fresh" },
        "Rebuild it and DELETE its data: users, channels, messages, uploads"));
    }
  }
  const note = ctx.$("#adv-gone");
  if (!note) return;
  const named = [...gone].map((f) => ADV_GONE_LABEL[f] || f);
  note.hidden = !named.length;
  note.textContent = named.length
    ? "Not on this runtime: " + named.join(" · ")
      + ". Each is refused with its reason rather than accepted and dropped."
    : "";
}

function syncDeploymentFields() {
  // --replicas means something on both runtimes, but nothing at all on a monolith.
  // Offering a field that is silently ignored is how `--seed` and `--https` were
  // quietly dropped on this runtime.
  ctx.$("#replicas-row").hidden = ctx.$("#deployment-value").value === "monolith";
}

// ---- HTTPS: certificate check ------------------------------------------------
const TLS_LABEL = {
  local: "local CA (run trust-ca)",
  acme: "Let's Encrypt",
  own: "supplied certificate",
};

function doTlsStatus(name) {
  return ctx.runAction(name, "Check TLS", async () => {
    const r = await ctx.api(`/api/repros/${name}/tls`);
    const lines = [`${r.public_url}`, ""];
    if (!r.serving) {
      lines.push(`NOT serving TLS on this host's port ${r.port}`, `  ${r.error}`, "",
                 "Rocket.Chat itself is fine on its plain http port — this is the TLS layer.");
    } else {
      lines.push(`Issuer   ${r.issuer || "?"}`, `Subject  ${r.subject || "?"}`,
                 `Expires  ${(r.dates || "").replace("notAfter=", "")}`, "");
      if (r.fallback) {
        // "NEVER SUCCEEDED" IS A CLAIM ABOUT THE PAST, and this check cannot see the
        // past. An ingress controller serves its own placeholder for a name it has no
        // certificate for YET, so on a fresh cluster this is the ordinary state for
        // the first minute or three — the same thing the `self_signed` branch below
        // already says correctly. Reported as a permanent failure it sends somebody
        // hunting an ACME problem that resolves itself while they read the logs.
        lines.push("This is the ingress controller's built-in placeholder "
                 + "certificate, so cert-manager has not issued one for this name "
                 + "yet.",
                   "On a fresh cluster that is normal for the first minute or three. "
                 + "Check again; if it persists, the ACME order is stuck — the "
                 + "workspace logs and `kubectl get certificate` in its namespace say "
                 + "what it is waiting on.");
      } else if (r.mode === "local") {
        lines.push(r.trusted_via_ca ? "Serving houston's local CA."
                                    : "WARNING: does not chain to houston's CA.");
        lines.push(r.trusted ? "This machine trusts it — trust-ca has been run."
                             : "Not trusted here yet: run `houston trust-ca` once.");
      } else if (r.trusted) {
        lines.push("Serving a certificate this machine trusts.");
      } else if (r.self_signed) {
        // NOT a failure, and it used to be reported as one — "does not trust —
        // normal for Let's Encrypt staging" on a workspace that was not using
        // staging and had no certificate yet at all.
        lines.push("Serving a self-signed certificate — nothing has issued one yet.",
                   "On Kubernetes the ingress serves its own until cert-manager "
                 + "finishes, a minute or three after the workspace answers.");
      } else if (r.staging) {
        lines.push("Serving a real certificate that this machine does not trust — "
                 + "normal for Let's Encrypt staging.");
      } else {
        lines.push(`Serving a certificate this machine does not trust, from `
                 + `${r.issuer || "an unnamed issuer"}.`,
                   "That is neither staging nor a placeholder, so something else is "
                 + "answering for this name — a proxy in front is the usual cause.");
      }
      if (r.public_issuer && r.public_issuer !== r.issuer) {
        lines.push("", `The public name serves a DIFFERENT certificate (${r.public_issuer}).`,
                   "That is what a proxy in front looks like (Cloudflare orange cloud).");
      } else if (r.public_error) {
        lines.push("", `The public name is not reachable from here: ${r.public_error}`);
      }
    }
    ctx.$("#pat-title").textContent = `TLS: ${name}`;
    ctx.$("#pat-body").textContent = lines.join("\n");
    ctx.PAT_HEADERS = "";
    ctx.$("#pat-dialog").showModal();
  });
}

// ---- HTTPS section of the create dialog -------------------------------------
// Two modes, and only one of them asks for anything: a domain and an email, the
// same pair the official Rocket.Chat compose takes as DOMAIN and LETSENCRYPT_EMAIL.
const HTTPS_MODE_HINT = {
  "": "",
  acme: "Traefik obtains a real, publicly trusted certificate from Let's Encrypt."
      + " The domain must already resolve to this host with port 443 reachable —"
      + " Let's Encrypt validates by connecting to it.",
  local: "A certificate signed by houston's own CA. Works offline, no domain, no rate"
       + " limits. Browsers warn until `houston trust-ca` has been run once. A phone"
       + " cannot use it — use Let's Encrypt for mobile.",
};

function syncHttpsFields() {
  const mode = ctx.$("#https-mode").value;
  ctx.$("#https-mode-hint").textContent = HTTPS_MODE_HINT[mode] || "";
  for (const el of document.querySelectorAll(".https-acme")) el.hidden = mode !== "acme";
  const email = ctx.$("#create-form") && ctx.$("#create-form").acme_email;
  if (email) {
    email.required = mode === "acme" && !ctx.ACME_EMAIL_REMEMBERED;
    email.placeholder = ctx.ACME_EMAIL_REMEMBERED
      ? "remembered — leave blank to reuse it"
      : "you@example.com";
  }
}

function applyHttpsToRequest(f, req) {
  const mode = f.https_mode ? f.https_mode.value : "";
  if (!mode) return true;
  const val = (k) => (f[k] && f[k].value.trim()) || "";
  if (mode === "local") { req.https = true; return true; }
  // Not on a cluster with a zone: the server names the workspace <name>.<zone> itself.
  if (!val("domain") && !chosenZone()) { ctx.toast("HTTPS: a domain is required for Let's Encrypt"); return false; }
  if (!val("acme_email") && !ctx.ACME_EMAIL_REMEMBERED) {
    ctx.toast("HTTPS: a contact email is required for Let's Encrypt");
    return false;
  }
  req.domain = val("domain");
  // The email may be blank when it is remembered in config. Everything else --
  // the challenge, the port, whether to publish publicly -- is derived server-side,
  // so the form does not ask for it.
  if (val("acme_email")) req.acme_email = val("acme_email");
  return true;
}

async function submitCreate() {
  const f = ctx.$("#create-form");
  const req = {
    version: f.version.value.trim(),
    port: f.port.value ? parseInt(f.port.value, 10) : 0,
    monitor: f.monitor.checked, seed: f.seed.checked, wait: f.wait.checked,
    // Always sent, both of them: omitting `runtime` would let the service's default
    // decide, which would silently stop matching what this dialog showed.
    runtime: f.runtime ? f.runtime.value : "docker",
    deployment: f.deployment ? f.deployment.value : "",
    // The presets, each one's settings and the license (options.js).
    ...ctx.optionsRequest(),
  };
  if (f.replicas && !ctx.$("#replicas-row").hidden && f.replicas.value) {
    req.replicas = parseInt(f.replicas.value, 10);
  }
  if (f.mongo_operator && f.mongo_operator.checked) req.mongo_operator = true;
  if (f.seed.checked && f.seed_profile) req.seed_profile = f.seed_profile.value;
  if (f.seed.checked) {
    const selection = ctx.seedRequest(f, "seed_"); if (selection === null) return;
    req.seed_scenarios = selection.scenarios;
    if (selection.history_days !== undefined) req.seed_history_days = selection.history_days;
  }
  if (!req.version) { ctx.toast("version is required"); f.version.focus(); return; }
  for (const k of ["name", "reg_token", "mongo", "rc_image", "bind", "root_url", "context"]) {
    if (f[k] && f[k].value.trim()) req[k] = f[k].value.trim();
  }
  // --offline and --no-pull stay on the command line; the dialog does not offer them.
  if (f.pin && f.pin.checked) req.pin = true;
  if (!applyHttpsToRequest(f, req)) return;      // validates before anything is sent
  const existing = f.existing ? f.existing.value : "reuse";
  if (existing === "force") req.force = true;
  if (existing === "fresh") {
    if (!confirm(`This DELETES ${req.name || "the existing repro"}'s data volume — all users, `
      + `channels, messages and uploads — then rebuilds it.\n\nContinue?`)) return;
    req.fresh = true;
  }
  // Until the server says which name it settled on (`named`): it derives one from the
  // version and presets, and puts the account in front.
  let label = req.name || req.version;
  const where = whereText(destFor(DEST));
  setCreateStep(3);
  const title = ctx.$("#create-progress-title");
  title.textContent = `Creating ${label} on ${where}`;
  ctx.$("#create-progress").innerHTML = "";
  ctx.$("#create-result").innerHTML = "";
  try {
    const { job_id } = await ctx.api("/api/repros", { method: "POST", body: JSON.stringify(req) });
    // The job's title is what its toasts say once the dialog is closed: the workspace, as
    // Activity names it, not the version asked for.
    ctx.streamJob(job_id, `Creating ${label}`, (r) => renderCreateDone(r, label),
      { list: ctx.$("#create-progress"), title, dialog: ctx.$("#create-dialog"), stop: ctx.$("#create-stop"),
        named: (name) => {
          label = name;
          title.textContent = `Creating ${label} on ${where}`;
          ctx.JOB.title = `Creating ${label}`;
        },
        failed: (data) => {
          title.textContent = data && data.kind === "Stopped" ? `${label} was stopped` : `${label} could not be created`;
          // It no longer "keeps starting": the job has ended.
          ctx.$("#create-foot-hint").textContent = "";
        } });
  } catch (e) {
    ctx.toast(e.message);
    setCreateStep(2, true);
  }
}

// What a finished create leaves in the dialog: where to go and how to sign in, then
// the preset's notes -- the same facts the CLI prints after `up`.
function renderCreateDone(r, label) {
  const name = (r && r.name) || label;
  ctx.$("#create-progress-title").textContent = `${name} is ready`;
  const box = ctx.$("#create-result");
  box.innerHTML = "";
  const url = (r && (r.public_url || r.root_url)) || "";
  if (url) {
    const call = ctx.el("div", { class: "callout info" }, "Open ", ctx.el("b", { class: "mono" }, url));
    if (r.login) call.append(" and sign in as ", ctx.el("b", {}, `${r.login.user} / ${r.login.password}`));
    call.append(".");
    box.append(call);
  }
  const kv = ctx.el("div", { class: "result-kv" });
  if (r && r.rc_version) kv.append(ctx.el("b", {}, "Rocket.Chat"), ctx.el("span", {}, `${r.rc_version} · MongoDB ${r.mongo_tag || "?"} · ${r.preset || "default"}`));
  for (const u of (r && r.instance_urls) || []) kv.append(ctx.el("b", {}, "Instance"), ctx.el("span", {}, u));
  if (r && r.grafana_url) kv.append(ctx.el("b", {}, "Grafana"), ctx.el("span", {}, r.grafana_url));
  if (kv.childElementCount) box.append(kv);
  if (r && r.notes && r.notes.length) ctx.appendNotes(box, r.notes);
  ctx.$("#create-foot-hint").textContent = "";
  const ws = ctx.$("#create-open-ws");
  ws.hidden = false;
  ws.onclick = () => { ctx.$("#create-dialog").close(); ctx.selectRepro(name); };
  const rc = ctx.$("#create-open-rc");
  if (url) { rc.href = url; rc.hidden = false; }
}

// ---- opening and moving through the dialog -----------------------------------------
function startCreate({ dest = "", step = 1 } = {}) {
  // Every open starts from the first usable place (Docker) unless a place was named. A
  // named place this person may not choose is said -- never quietly swapped for Docker.
  const named = dest ? destFor(dest) : null;
  DEST = named && named.usable ? dest : "";
  renderDestinations();
  if (dest && !(named && named.usable)) {
    ctx.toast(named ? `${named.nm} cannot take a workspace right now.` : "Choosing a cluster is kept to admins on this server; pick where it runs.", "info");
  }
  setCreateStep(step === 2 && named && named.usable ? 2 : 1);
}

function createNext() {
  const p = destFor(DEST);
  if (!p || !p.usable) { ctx.toast("Pick where it runs first."); return; }
  setCreateStep(2);
}

ctx.$("#create-next").addEventListener("click", createNext);
ctx.$("#create-back").addEventListener("click", () => setCreateStep(1, true));
ctx.$("#create-change").addEventListener("click", () => setCreateStep(1, true));
ctx.$("#create-x").addEventListener("click", () => ctx.$("#create-dialog").close());
ctx.$("#create-form").addEventListener("keydown", (ev) => {
  // Enter moves forward the way the button on screen would; it never submits step 1.
  if (ev.key !== "Enter" || ev.target.tagName === "TEXTAREA" || ev.target.tagName === "BUTTON") return;
  if (CREATE_STEP === 1) { ev.preventDefault(); createNext(); }
});
ctx.$("#create-form").version.addEventListener("input", () => {
  if (CREATE_STEP === 2) ctx.$("#create-foot-hint").textContent = createSummaryLine();
});
// A create still running when the dialog is closed carries on, and says how it ended.
ctx.$("#create-dialog").addEventListener("close", () => {
  const job = ctx.JOB;
  if (job && job.view && job.view.dialog === ctx.$("#create-dialog")) {
    ctx.closeJobStream();
    if (!job.finished) ctx.watchDetachedJob(job);
  }
});

Object.defineProperties(ctx, {
  "RUNTIMES": { enumerable: true, get: () => RUNTIMES, set: value => { RUNTIMES = value; } },
  "RUNTIME_LABEL": { enumerable: true, get: () => RUNTIME_LABEL },
  "runtimeLabel": { enumerable: true, get: () => runtimeLabel },
  "DEPLOYMENT_LABEL": { enumerable: true, get: () => DEPLOYMENT_LABEL },
  "DEPLOYMENT_NOTE": { enumerable: true, get: () => DEPLOYMENT_NOTE },
  "fmtGb": { enumerable: true, get: () => fmtGb },
  "renderRuntimeAxes": { enumerable: true, get: () => renderRuntimeAxes },
  "pickRuntime": { enumerable: true, get: () => pickRuntime },
  "pickDeployment": { enumerable: true, get: () => pickDeployment },
  "ADV_GONE_LABEL": { enumerable: true, get: () => ADV_GONE_LABEL },
  "KUBE_CLUSTERS": { enumerable: true, get: () => KUBE_CLUSTERS, set: value => { KUBE_CLUSTERS = value; } },
  "ALL_KUBE_CLUSTERS": { enumerable: true, get: () => ALL_KUBE_CLUSTERS, set: value => { ALL_KUBE_CLUSTERS = value; } },
  "MACHINE_ROOM": { enumerable: true, get: () => MACHINE_ROOM, set: value => { MACHINE_ROOM = value; } },
  "clusterLabel": { enumerable: true, get: () => clusterLabel },
  "PLACE_ICON": { enumerable: true, get: () => PLACE_ICON },
  "placeIcon": { enumerable: true, get: () => icon },
  "places": { enumerable: true, get: () => places },
  "placeBody": { enumerable: true, get: () => placeBody },
  "placeState": { enumerable: true, get: () => placeState },
  "placeWarn": { enumerable: true, get: () => placeWarn },
  "perDay": { enumerable: true, get: () => perDay },
  "plural": { enumerable: true, get: () => plural },
  "emptyContextRow": { enumerable: true, get: () => emptyContextRow },
  "zoneHead": { enumerable: true, get: () => zoneHead },
  "renderDestinations": { enumerable: true, get: () => renderDestinations },
  "pickDest": { enumerable: true, get: () => pickDest },
  "startCreate": { enumerable: true, get: () => startCreate },
  "setCreateStep": { enumerable: true, get: () => setCreateStep },
  "runsOnThisMachine": { enumerable: true, get: () => runsOnThisMachine },
  "syncLocalCaOption": { enumerable: true, get: () => syncLocalCaOption },
  "syncClusterNote": { enumerable: true, get: () => syncClusterNote },
  "syncAdvancedForRuntime": { enumerable: true, get: () => syncAdvancedForRuntime },
  "syncDeploymentFields": { enumerable: true, get: () => syncDeploymentFields },
  "TLS_LABEL": { enumerable: true, get: () => TLS_LABEL },
  "doTlsStatus": { enumerable: true, get: () => doTlsStatus },
  "HTTPS_MODE_HINT": { enumerable: true, get: () => HTTPS_MODE_HINT },
  "syncHttpsFields": { enumerable: true, get: () => syncHttpsFields },
  "applyHttpsToRequest": { enumerable: true, get: () => applyHttpsToRequest },
  "submitCreate": { enumerable: true, get: () => submitCreate },
  "createSummaryLine": { enumerable: true, get: () => createSummaryLine },
});
export { RUNTIMES, RUNTIME_LABEL, runtimeLabel, DEPLOYMENT_LABEL, DEPLOYMENT_NOTE, fmtGb, renderRuntimeAxes, pickRuntime, pickDeployment, ADV_GONE_LABEL, KUBE_CLUSTERS, ALL_KUBE_CLUSTERS, MACHINE_ROOM, clusterLabel, places, placeBody, renderDestinations, pickDest, startCreate, setCreateStep, runsOnThisMachine, syncLocalCaOption, syncClusterNote, syncAdvancedForRuntime, syncDeploymentFields, TLS_LABEL, doTlsStatus, HTTPS_MODE_HINT, syncHttpsFields, applyHttpsToRequest, submitCreate };
