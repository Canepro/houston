import { ctx } from "./shared.js";

// ---- clusters: where workspaces run, and what that is costing ----------------
// Two halves, as the edge has: a chip that is always visible when something in AWS is
// billing, so a forgotten cluster cannot stay forgotten, and a page with room for it.
// The page is Amazon EKS's: Docker and a Kubernetes on this machine only ever change
// state (installed or not, running or not), so they get one slim card at the top.
let CLUSTERS = null;          // the cheap list: what contexts exist
const CLSTATE = {             // per-context status, filled in from the overview
  status: {},                 // context -> the status document, or null while loading
  deleting: "",               // which cluster the delete dialog is about
  deletingRow: null,          // its row, for the region
  overview: null,             // the one answer the page renders: /api/clusters/overview
  overviewAt: 0,              // when it was read, so Home and the page share one read
  overviewError: "",          // why the last read failed, so nothing waits on it forever
  selected: "",               // the place whose own view is open
  jobs: [],                   // running cluster jobs, for the building/deleting cards
  jobsRead: false,            // whether /api/jobs has been read since the page loaded
  full: {},                   // context -> the full read of a cluster not in AWS, once opened
  connection: null,           // server AWS identity; never browser credentials
  connectionAt: 0,
};

const clCost = (st) => (st && st.cost && st.cost.usd_hr) || 0;

function clAttention(st) {
  // What makes a cluster want you, in the sense the colour rule means. NOT cost.
  if (!st) return "";
  if (st.gone) return "AWS says this cluster no longer exists — its kubeconfig entry "
                      + "is left over";
  if (!st.reachable) return st.reach_why || "it could not be read";
  if (st.expires_in_days !== undefined && st.expires_in_days !== null
      && st.expires_in_days < 0) return `expired ${-st.expires_in_days} day(s) ago`;
  if ((st.unreadable || []).length) return `${st.unreadable.join(", ")} could not be read`;
  return "";
}

// SERVICE MESSAGES ARE WRITTEN FOR A TERMINAL, where `like this` is a command. One
// helper renders them, rather than a second set of messages written for the browser.
function codeText(text) {
  const out = [];
  String(text ?? "").split("`").forEach((part, i) => {
    if (part === "") return;
    out.push(i % 2 ? ctx.el("code", {}, part) : part);
  });
  return out;
}

const clShort = (row) => row.short || String(row.context).split("/").pop();
const clRegion = (row, st) => (st && st.region) || row.region || "local";
// WHERE A CLUSTER LIVES decides which part of the page shows it. Only AWS bills.
const clWhere = (row, st) => (st && st.where) || (row && row.where) || "aws";
// Whether a cluster-create job is running for this row's cluster: its "Building" card speaks
// for it. The name AND the region: a name is unique per region, so another cluster of the
// same name elsewhere -- billing -- must stay on the page.
const clBuilding = (row) => CLSTATE.jobs.some((j) => j.kind === "cluster-create" && j.label === clShort(row)
  && (!j.region || !row.region || j.region === row.region));
const clRows = (where) => ((CLUSTERS && CLUSTERS.contexts) || []).filter((r) => clWhere(r, CLSTATE.status[r.context]) === where && !clBuilding(r));

// The words both front-ends use for a state.
function clStateOf(st) {
  if (!st) return ["reading", "reading…"];
  if (st.gone) return ["gone", "gone in AWS"];
  if (st.reachable) return ["running", "running"];
  if (st.reach_status === "denied") return ["refusing", "refusing"];
  if (st.reach_status === "no-context") return ["unreachable", "no credentials"];
  return ["unreachable", "not answering"];
}

function clNodes(st) {
  const shapes = (st && st.instance_types) ? Object.entries(st.instance_types) : [];
  if (shapes.length) return shapes.map(([t, c]) => `${c} × ${t || "unlabelled"}`).join(", ");
  return st && st.nodes !== null && st.nodes !== undefined ? `${st.nodes} node${st.nodes === 1 ? "" : "s"}` : "";
}

function clBuiltBy(row, st) {
  if ((st && st.made_by_houston === true) || row.ours || row.made_by_houston) return "houston";
  if (st && st.made_by_houston === false) return "you";
  return "?";
}

// A command, set so a line never breaks inside one of its words.
function cmdCode(text) {
  const code = ctx.el("code", {});
  String(text).split(" ").forEach((word, i) => {
    if (i) code.append(" ");
    code.append(ctx.el("span", { class: "tok" }, word));
  });
  return code;
}

// ---- the server's AWS identity ---------------------------------------------------
// One answer for every place that says it: the page, Home, the chip and the setup.
// From /api/clusters/connection when it has been read, else from the overview's
// preflight -- which carries the same `whoami` error -- so Home never needs a call
// of its own.
function awsSignIn() {
  const c = CLSTATE.connection;
  const pre = CLSTATE.overview && CLSTATE.overview.preflight;
  const principal = (c && c.principal) || (pre && pre.identity) || "";
  const account = (c && c.account) || (pre && pre.account) || "";
  const blocker = ((pre && pre.blockers) || []).find((b) => /^not signed in to AWS/u.test(b)) || "";
  const error = (c && c.error) || blocker;
  if (account && !(c && c.error)) {
    const tail = principal.split(":").pop() || "";
    const parts = tail.split("/");
    const kind = parts[0] === "user" ? "user" : parts[0] === "assumed-role" ? "role" : parts[0] === "role" ? "role" : "";
    const name = parts[0] === "assumed-role" ? (parts[2] || parts[1] || tail) : (parts[parts.length - 1] || tail);
    return { state: "signed", name, kind, account, principal,
      region: (c && c.region) || (pre && pre.region) || "", profile: (c && c.profile) || "" };
  }
  if (!c && !pre) return { state: "unknown" };
  const expired = /expired/iu.test(error);
  return { state: expired ? "expired" : "none", error, profile: (c && c.profile) || "", profiles: (c && c.profiles) || [] };
}

async function clReadConnection(force = false) {
  if (!force && CLSTATE.connection && Date.now() - CLSTATE.connectionAt < 120000) return CLSTATE.connection;
  try { CLSTATE.connection = await ctx.api("/api/clusters/connection"); }
  catch (error) { CLSTATE.connection = { error: error.message }; }
  CLSTATE.connectionAt = Date.now();
  return CLSTATE.connection;
}

// ---- the chip ------------------------------------------------------------------
// Only when something is in AWS: a free cluster on this machine has nothing to remind
// anybody about. Amber when one wants you; never red -- red is for destroying something.
async function refreshClusterBadge() {
  const badge = ctx.$("#cluster-badge");
  if (!badge) return;
  try { CLUSTERS = await ctx.api("/api/clusters"); CLSTATE.listError = ""; }
  catch (e) { CLSTATE.listError = e.message; badge.hidden = true; return; }      // no gui extra / no permission
  // The rows every view draws from follow the list now, not only when a build starts or ends:
  // the Clusters page opened after this read drew "no cluster on this machine" for a running
  // k3s until its own read came back.
  clSyncRows();
  // ALSO ONCE AFTER A PAGE LOAD. Read only while a job was already known, a build running
  // when the page was refreshed was invisible on Home and in this chip until someone opened
  // Clusters -- and its cluster's own warning arrived a minute later in its place.
  if (CLSTATE.jobs.length || !CLSTATE.jobsRead) {
    try {
      const jobs = await ctx.api("/api/jobs");
      const before = CLSTATE.jobs.map((j) => j.id).join();
      CLSTATE.jobs = (jobs.jobs || []).filter((j) => (j.kind === "cluster-create" || j.kind === "cluster-delete") && ctx.jobActive(j.status));
      CLSTATE.jobsRead = true;
      if (CLSTATE.jobs.map((j) => j.id).join() !== before) {
        clSyncRows();
        if (ctx.VIEW === "home" && !ctx.SELECTED) ctx.renderHome();
      }
    } catch (_) { /* keep what is known */ }
  }
  const aws = clRows("aws");
  const building = CLSTATE.jobs.filter((j) => j.kind === "cluster-create");
  if (!aws.length && !building.length) { badge.hidden = true; return; }
  badge.hidden = false;
  const sts = aws.map((r) => CLSTATE.status[r.context]).filter(Boolean);
  const sign = awsSignIn();
  const t = CLSTATE.overview ? CLSTATE.overview.totals : null;
  const wants = sign.state === "expired" || building.length
    || sts.some((st) => clAttention(st) || ctx.placeWarn(st));
  let text = "EKS";
  if (sign.state === "expired") text = "EKS · AWS sign-in expired";
  else if (building.length) text = "EKS · building";
  else if (t && t.usd_day !== null && t.usd_day !== undefined) {
    text = `EKS ~$${Number(t.usd_day).toFixed(2)}/day${t.unpriced ? "+" : ""}`;
  } else if (sts.length) {
    const perHr = sts.reduce((sum, st) => sum + clCost(st), 0);
    if (perHr) text = `EKS ~$${(perHr * 24).toFixed(2)}/day`;
  }
  badge.textContent = text;
  badge.className = "chip" + (wants ? " warn" : " up");
}

// ---- the page --------------------------------------------------------------------
let pageReads = 0;            // the newest open wins; an older read never repaints over it

function pvWrap(anim) {
  const panel = ctx.$("#detail");
  panel.innerHTML = "";
  const box = ctx.el("div", { class: "pv" + (anim ? " anim" : "") });
  panel.append(box);
  return box;
}

async function openClusters() {
  // THE ROLE BEFORE THE PAGE: every control here is role-aware, and MY_ROLE is filled
  // in by the poll rather than at load.
  if (!ctx.MY_ROLE) {
    try {
      const me = await ctx.api("/api/session");
      ctx.ACCOUNTS = !!me.accounts; ctx.ME = me.user || ""; ctx.MY_ROLE = me.role || "";
    } catch (_) { /* signed out; api() has already redirected */ }
  }
  const fresh = ctx.VIEW !== "clusters";
  ctx.setView("clusters");
  ctx.$(".panes").classList.add("no-detail");
  ctx.$("#actpane").innerHTML = "";
  const read = ++pageReads;
  if (CLUSTERS) clSyncRows();         // the first draw shows the clusters already known
  clRenderPage(fresh);
  try {
    CLUSTERS = await ctx.api("/api/clusters");
    CLSTATE.listError = "";
  } catch (e) { CLSTATE.listError = e.message; }
  clSyncRows();
  if (read !== pageReads || ctx.VIEW !== "clusters") return;
  clRenderPage(false);
  const jobs = ctx.api("/api/jobs").catch(() => ({ jobs: [] }));
  const [ov] = await Promise.all([
    loadClusterOverview(true, { evenWithoutClusters: true }).catch((e) => { CLSTATE.overviewError = e.message; return null; }),
    clReadConnection(),
    clReadPolicy(),
    ctx.KUBE ? Promise.resolve() : ctx.refreshKube(),
  ]);
  if (ov) CLSTATE.overviewError = "";
  CLSTATE.jobs = ((await jobs).jobs || []).filter((j) => (j.kind === "cluster-create" || j.kind === "cluster-delete") && ctx.jobActive(j.status));
  CLSTATE.jobsRead = true;
  clSyncRows();
  if (read !== pageReads || ctx.VIEW !== "clusters") return;
  clRenderPage(false);
  refreshClusterBadge();
}

// The places read their rows from the same lists the Create dialog uses. A cluster being
// built is left out: eksctl writes its kubeconfig context part-way through the build, and
// from then the page drew its "Building" card AND a card of its own for the same cluster.
function clSyncRows() {
  const rows = (CLUSTERS && CLUSTERS.contexts) || [];
  ctx.ALL_KUBE_CLUSTERS = rows;
  ctx.KUBE_CLUSTERS = rows.filter((r) => clWhere(r, CLSTATE.status[r.context]) !== "elsewhere" && !clBuilding(r));
}

function clRenderPage(anim) {
  const box = pvWrap(anim);
  box.append(ctx.el("h1", {}, "Clusters"), ctx.el("p", { class: "sub" }, "Where your workspaces can run."));
  const { here, aws } = ctx.places({ inventory: true });
  // This machine: one slim card, a row each.
  const list = ctx.el("div", { class: "pcard mlist" });
  for (const p of here) list.append(machineRow(p));
  box.append(ctx.el("section", { class: "mstrip", id: "cl-local" },
    ctx.el("div", { class: "zone-h" }, ctx.el("h2", { class: "small" }, "This machine"), ctx.el("span", { class: "tag" }, "Free")), list));
  // Amazon EKS: the page.
  const zone = ctx.el("section", { class: "zone eks", id: "cl-aws" });
  const head = ctx.el("div", { class: "zone-h" }, ctx.el("h2", {}, "Amazon EKS"),
    ctx.el("span", { class: "tag money" }, "Costs money"), ctx.el("span", { class: "sp" }));
  const jobs = CLSTATE.jobs;
  const failed = (CLSTATE.overview && CLSTATE.overview.failed) || [];
  const any = aws.length || jobs.length || failed.length;
  if (ctx.canAdmin() && any) head.append(ctx.el("button", { class: "btn sm", type: "button", onclick: () => openEksSetup() }, "+ Add a cluster"));
  zone.append(head, ctx.el("p", { class: "zone-p" }, "A Kubernetes cluster in your AWS account. Everyone on this server "
    + "shares it, and AWS bills it by the hour until it is deleted, whether or not a workspace runs on it."));
  const ident = identLine(any);
  if (ident) zone.append(ident);
  if (CLSTATE.listError || CLSTATE.overviewError) {
    zone.append(ctx.el("div", { class: "zerr", role: "alert" },
      ctx.el("span", {}, `Couldn't read the clusters: ${CLSTATE.listError || CLSTATE.overviewError}`),
      ctx.el("button", { class: "btn sm", type: "button", onclick: () => { CLSTATE.overviewError = ""; openClusters(); } }, "Try again")));
  }
  if (any) {
    const grid = ctx.el("div", { class: "places eks", id: "cl-eks" });
    for (const p of aws) grid.append(eksCard(p));
    for (const j of jobs) grid.append(jobCard(j));
    for (const b of failed) grid.append(failedCard(b));
    zone.append(grid);
    const t = CLSTATE.overview ? CLSTATE.overview.totals : null;
    if (t && t.clusters > 1 && t.usd_day !== null && t.usd_day !== undefined) {
      zone.append(ctx.el("div", { class: "ident" }, `${t.clusters} clusters · `, ctx.el("b", {}, `~$${Number(t.usd_day).toFixed(2)} a day`),
        ` together${t.unpriced ? ` (+ ${t.unpriced} not priced)` : ""}`
        + (t.spend_usd !== null && t.spend_usd !== undefined ? ` · ~$${Number(t.spend_usd).toFixed(2)} so far` : "") + " · estimates"));
    }
  } else if (!CLSTATE.listError && !CLSTATE.overviewError) {
    zone.append(ctx.canAdmin() ? eksHero()
      : ctx.el("div", { class: "pcard place muted" }, ctx.el("div", { class: "nm" }, "Amazon EKS isn't set up on this server"),
        ctx.el("p", { class: "ds" }, "An admin sets it up. Until then, workspaces run on this machine.")));
  }
  box.append(zone);
}

function identLine(any) {
  const s = awsSignIn();
  if (s.state === "signed") {
    const line = ctx.el("div", { class: "ident top", id: "cl-connection" }, "Signed in to AWS on the server as ",
      ctx.el("b", {}, s.name), s.kind ? ` (${s.kind})` : "", ` · account ${s.account}`, s.region ? ` · ${s.region}` : "");
    line.title = s.principal;
    if (ctx.canAdmin()) line.append(" · ", ctx.el("button", { class: "linkbtn", type: "button", onclick: () => openEksSetup() }, "Details"));
    return line;
  }
  if (s.state === "expired") {
    return ctx.el("div", { class: "ident top bad", id: "cl-connection" }, "▲ ", ctx.el("b", {}, "The server's AWS sign-in has expired."),
      " Houston can't check these clusters or their cost. ",
      ctx.canAdmin() ? ctx.el("button", { class: "linkbtn", type: "button", onclick: () => openEksSetup() }, "Sign in again")
        : "An admin signs in again on the server.");
  }
  if (s.state === "none" && any) {
    return ctx.el("div", { class: "ident top", id: "cl-connection" }, "AWS isn't connected on the server. ",
      ctx.canAdmin() ? ctx.el("button", { class: "linkbtn", type: "button", onclick: () => openEksSetup() }, "How to connect") : "");
  }
  return null;
}

function machineRow(p) {
  const opens = p.key === "docker" || p.key.startsWith("k8s:");
  const note = p.key === "k8s-new" ? "Set up automatically the first time you use it"
    : p.key === "k8s-none" ? (p.ds || "") : p.facts[0] || "";
  const sub = p.wh.replace(/^On this machine( · )?/u, "");
  const row = ctx.el("div", { class: "mrow" + (opens ? " click" : ""), "data-place": p.key },
    ctx.placeIcon(p.ico),
    ctx.el("div", { class: "mname" }, ctx.el("b", {}, p.nm), sub ? ctx.el("span", { class: "wh" }, ` · ${sub}`) : ""),
    ctx.el("span", {}, ctx.el("span", { class: `pill ${p.pill[0]}` }, p.pill[1])),
    ctx.el("span", { class: "wh mnote" }, note),
    ctx.el("span", { class: "mact" }, createDestOf(p)
      ? ctx.el("button", { class: "btn sm", type: "button", onclick: (ev) => { ev.stopPropagation(); ctx.openCreate(undefined, { dest: createDestOf(p) }); } }, "Create here") : ""));
  if (opens) row.addEventListener("click", () => openPlace(p.key));
  return row;
}

// Where "Create here" can actually go. Under `gui.create_policy admin` the form cannot send
// a cluster for a member, so a named one is offered only when it is the server's default
// -- the dialog's "default" card -- and otherwise not at all: it opened Create, toasted,
// and dropped the member back on step 1 (the deferred M5 of the EKS redesign).
function createDestOf(p) {
  if (!ctx.canWrite() || !p.usable) return "";
  if (!p.context || ctx.MAY_SET_PRIVILEGED === true) return p.key;
  const lands = ctx.emptyContextRow();
  return p.row && lands && p.row.context === lands.context ? "k8s-default" : "";
}

// The policy that decides it, read with the page: Create reads it when it opens, and the
// page draws its buttons before that.
async function clReadPolicy() {
  try { ctx.MAY_SET_PRIVILEGED = !!(await ctx.api("/api/settings")).may_set_privileged; }
  catch (_) { /* the buttons stay as the last read left them */ }
}

function eksCard(p) {
  const card = ctx.el("div", { class: "pcard place click", "data-place": p.key, "data-context": p.context, tabindex: "0", role: "button",
    "aria-label": `${p.nm}, ${p.wh}` }, ...ctx.placeBody(p));
  const acts = [];
  // The DNS record is the step a new cluster is waiting on, so it gets a button where the
  // card says so -- not only an entry in the cluster's own pane.
  if (/^Public names under/u.test(p.warn || "") && p.row) {
    acts.push(ctx.el("button", { class: "btn sm", type: "button",
      onclick: (ev) => { ev.stopPropagation(); clOpenDns(p.row); } }, "Set up DNS"));
  }
  if (createDestOf(p)) {
    acts.push(ctx.el("button", { class: "btn sm", type: "button",
      onclick: (ev) => { ev.stopPropagation(); ctx.openCreate(undefined, { dest: createDestOf(p) }); } }, "Create here"));
  }
  if (acts.length) card.append(ctx.el("div", { class: "acts" }, ...acts));
  card.addEventListener("click", () => openPlace(p.key));
  card.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target === card) openPlace(p.key); });
  return card;
}

function jobCard(job) {
  const deleting = job.kind === "cluster-delete";
  const min = Math.max(0, Math.floor((Date.now() / 1000 - job.started_at) / 60));
  const p = { ico: "aws", nm: job.label || "?", wh: "Amazon EKS", pill: ["busy warn", `${deleting ? "Deleting" : "Building"} · ${min} min`],
    ds: deleting ? "Releasing its load balancers, then the cluster and everything in it."
      : "About 20 minutes in all. It started billing when the build began.",
    progress: deleting ? null : Math.min(95, Math.round((min / 20) * 100)), facts: [] };
  const card = ctx.el("div", { class: "pcard place click", "data-job": job.id, role: "button", tabindex: "0" }, ...ctx.placeBody(p));
  card.addEventListener("click", () => ctx.reopenJob(job));
  return card;
}

function failedCard(build) {
  const gone = build.present === false;
  const cmd = `houston cluster delete ${build.name}${build.region ? ` --region ${build.region}` : ""}`;
  const p = { ico: "aws", nm: build.name, wh: `Amazon EKS · ${build.region || "?"}`,
    pill: ["warn", gone ? "Build failed, nothing left" : "Build failed"],
    ds: gone ? "The build failed and AWS holds nothing of it." : "The build failed part-way and may still be billing. Delete what it left:",
    facts: [] };
  const card = ctx.el("div", { class: "pcard place", "data-failed": build.name }, ...ctx.placeBody(p));
  if (!gone) {
    card.append(ctx.el("div", { class: "acts" }, cmdCode(cmd),
      ctx.el("button", { class: "btn sm", type: "button", onclick: () => clCopy(cmd, "the command") }, "Copy")));
  }
  return card;
}

function eksHero() {
  const s = awsSignIn();
  const signed = s.state === "signed";
  return ctx.el("div", { class: "pcard hero", id: "cl-hero" },
    ctx.el("div", { class: "ph" }, ctx.placeIcon("aws"), ctx.el("div", {}, ctx.el("div", { class: "nm" }, "Run workspaces on Amazon EKS"),
      ctx.el("div", { class: "wh" }, "For when what you test needs a real cloud cluster: AWS load balancers, EBS storage, several nodes."))),
    ctx.el("ol", { class: "hsteps" },
      ctx.el("li", {}, ctx.el("i", {}, signed ? "✓" : "1"), ctx.el("b", {}, "Connect AWS on the server"),
        ctx.el("span", {}, signed ? `Done: signed in as ${s.name}${s.kind ? ` (${s.kind})` : ""}.`
          : "Company SSO or a server role. Houston never asks for AWS keys here.")),
      ctx.el("li", {}, ctx.el("i", {}, "2"), ctx.el("b", {}, "Choose a cluster"),
        ctx.el("span", {}, "Build a new one (about 20 minutes), or connect one houston already built.")),
      ctx.el("li", {}, ctx.el("i", {}, "3"), ctx.el("b", {}, "Create workspaces on it"),
        ctx.el("span", {}, "It appears as a place to run, next to Docker, when you create a workspace."))),
    ctx.el("div", { class: "hero-f" }, ctx.el("button", { class: "btn solid", type: "button", onclick: () => openEksSetup() }, "Set up Amazon EKS"),
      ctx.el("span", { class: "wh" }, `A cluster costs about $${heroDay()} a day while it exists, whether or not anything runs on it.`)));
}

let HERO_DAY = null;
function heroDay() {
  if (HERO_DAY === null) {
    HERO_DAY = "…";
    ctx.api("/api/clusters/estimate?nodes=3").then((r) => {
      HERO_DAY = Number(r.usd_day).toFixed(2);
      const hero = ctx.$("#cl-hero .hero-f .wh");
      if (hero) hero.textContent = `A cluster costs about $${HERO_DAY} a day while it exists, whether or not anything runs on it.`;
    }).catch(() => { HERO_DAY = "?"; });
  }
  return HERO_DAY;
}

// ---- one place's own view: facts in the stage, actions in the pane ---------------
function placeOf(key) {
  const { here, aws } = ctx.places({ inventory: true });
  return [...here, ...aws].find((p) => p.key === key) || null;
}

async function openPlace(key) {
  ctx.SELECTED = null;
  ctx.closeLogs();
  if (ctx.dstate.statsTimer) { clearInterval(ctx.dstate.statsTimer); ctx.dstate.statsTimer = null; }
  ctx.dstate.detail = null;
  CLSTATE.selected = key;
  const fresh = ctx.VIEW !== "cluster";
  ctx.setView("cluster");
  ctx.$(".panes").classList.remove("no-detail");
  if (CLUSTERS) clSyncRows();
  clRenderPlace(fresh);
  if (!CLUSTERS) { try { CLUSTERS = await ctx.api("/api/clusters"); } catch (_) { /* the view says what it has */ } }
  clSyncRows();
  const p = placeOf(key);
  const reads = [p && p.row && p.row.where === "local" ? clReadFull(p.row) : null, clReadPolicy()];
  if (!CLSTATE.overview) reads.push(loadClusterOverview(false, { evenWithoutClusters: true }).catch(() => null));
  await Promise.all(reads);
  if (ctx.VIEW === "cluster" && CLSTATE.selected === key) clRenderPlace(false);
}

// Refresh, on either Clusters view: every read again, the AWS side past the server's
// ten-minute cache, because whoever presses it has usually just changed something there.
async function clRefresh() {
  CLUSTERS = null;
  await Promise.all([clReadConnection(true),
    loadClusterOverview(true, { evenWithoutClusters: true, fresh: true }).catch(() => null)]);
  if (ctx.VIEW === "cluster") await openPlace(CLSTATE.selected);
  else if (ctx.VIEW === "clusters") await openClusters();
}

// A cluster named by its context -- a workspace's "Runs on" -- opened as its own view.
function openContext(context) {
  const row = ((CLUSTERS && CLUSTERS.contexts) || []).find((r) => r.context === context);
  const where = row ? clWhere(row, CLSTATE.status[context]) : String(context).startsWith("arn:aws:eks:") ? "aws" : "local";
  if (where === "elsewhere") { openClusters(); return; }
  openPlace(`${where === "aws" ? "eks" : "k8s"}:${context}`);
}

function kvGrid(rows) {
  const grid = ctx.el("div", { class: "pkv" });
  for (const [k, ...v] of rows) grid.append(ctx.el("div", { class: "k" }, k), ctx.el("div", {}, ...v));
  return ctx.el("div", { class: "hcard dash" }, grid);
}

const okT = (t) => ctx.el("span", {}, ctx.el("span", { class: "ok-t" }, "✓"), ` ${t}`);
const noT = (t) => ctx.el("span", {}, ctx.el("span", { class: "no-t" }, "✗"), ` ${t}`);
function joinDots(items) { const out = []; items.forEach((it, i) => { if (i) out.push(" · "); out.push(it); }); return out; }

function heldList(held) {
  if (held === null || held === undefined) return [ctx.el("span", { class: "m" }, "could not be read — not the same as none")];
  if (!held.length) return ["None yet"];
  const out = [];
  held.forEach((w, i) => {
    if (i) out.push(ctx.el("br"));
    out.push(w.name || String(w), ctx.el("span", { class: "m" },
      w.name ? ` (${w.owner_readable === false ? "owner unreadable" : (w.owner || "unowned")}${typeof w.pvcs === "number" ? `, ${w.pvcs} volume${w.pvcs === 1 ? "" : "s"}` : ""})` : ""));
  });
  return out;
}

function clRenderPlace(anim) {
  const key = CLSTATE.selected;
  const p = placeOf(key);
  const box = pvWrap(anim);
  box.append(ctx.el("div", { class: "crumb" }, ctx.el("button", { class: "linkbtn", type: "button", onclick: () => openClusters() }, "Clusters"),
    ` › ${p ? p.nm : key.replace(/^[a-z0-9-]+:/u, "")}`));
  if (!p) { box.append(ctx.el("p", { class: "sub" }, "This cluster is no longer listed on this server.")); clPlacePane(null); return; }
  const head = ctx.el("div", { class: "dhead" }, ctx.placeIcon(p.ico),
    ctx.el("div", {}, ctx.el("h1", {}, p.nm), ctx.el("div", { class: "wh" }, p.wh)),
    ctx.el("span", { class: `pill ${p.pill[0]}` }, p.pill[1]));
  if (p.cost !== null && p.cost !== undefined) head.append(ctx.el("span", { class: "dcost" }, `~$${p.cost.toFixed(2)}`, ctx.el("small", {}, " a day")));
  box.append(head);
  const st = p.context ? CLSTATE.status[p.context] : null;
  if (p.key === "docker") {
    const ws = (ctx.ALL_REPROS || []).filter((r) => (r.runtime || "docker") === "docker");
    const cap = ctx.MACHINE_ROOM || ctx.HOME.cap;
    box.append(kvGrid([
      ["Workspaces", ...heldList(ws.map((r) => ({ name: r.name, owner: `${r.rc_version} · ${r.state}` })))],
      ["Memory", cap && cap.known ? `Room for about ${cap.room} more workspaces` : "Not read on this machine"],
      ["Engine", ctx.DOCKER_OK === false ? "Docker is not answering" : "Docker, with Compose"],
    ]));
  } else if (p.ico === "k8s") {
    const full = CLSTATE.full[p.context];
    const r = full && full.ready;
    // FACTS, NOT A CHECKLIST: a k3s ships its storage class and its ingress, and
    // "✓ ingress traefik" read as houston having installed it.
    const uses = full === undefined ? [ctx.el("span", { class: "m" }, "reading…")]
      : !r ? [ctx.el("span", { class: "m" }, "could not be read — not the same as nothing")]
      : joinDots([r.storage_class ? `storage class ${r.storage_class}` : noT("no default storage class"),
        r.ingress_class ? `ingress ${r.ingress_class}` : "no ingress",
        ...(r.cert_manager ? ["cert-manager"] : [])]);
    const nodes = full && typeof full.nodes === "number" ? `${full.nodes} node${full.nodes === 1 ? "" : "s"}` : "";
    const up = full && typeof full.age_hours === "number" ? `up ${Math.floor(full.age_hours / 24)}d ${Math.floor(full.age_hours % 24)}h` : "";
    if (st && !st.reachable) box.append(ctx.el("div", { class: "callout money", style: "margin:0 0 1rem" }, "▲ ", ...codeText(`${st.reach_why || "it could not be read"}. ${st.reach_advice || ""}`), ctx.el("b", {}, " These are unknown, not zero.")));
    box.append(kvGrid([
      ["Workspaces", ...heldList((full && full.workspaces) || (st && st.workspaces))],
      ["Uses", ...uses],
      ["Details", [(st && st.distribution) || (p.row && p.row.ours ? "kind" : "kubernetes"), nodes, `context ${p.context}`, up].filter(Boolean).join(" · ")],
      ["Cost", "Free: it runs on this machine"],
    ]));
  } else {
    if (p.warn) box.append(ctx.el("div", { class: "callout money", style: "margin:0 0 1rem" }, `▲ ${p.warn}`));
    if (st && st.gone) box.append(ctx.el("div", { class: "callout", style: "margin:0 0 1rem" }, ...codeText(st.reach_advice || "AWS says this cluster no longer exists, so it is not costing anything.")));
    else if (st && !st.reachable) box.append(ctx.el("div", { class: "callout money", style: "margin:0 0 1rem" }, ctx.el("b", {}, "These are unknown, not zero. "), ...codeText(st.reach_advice || "")));
    if (st && st.manageable === false && st.unmanageable_why) box.append(ctx.el("div", { class: "callout money", style: "margin:0 0 1rem" }, ...codeText(st.unmanageable_why)));
    const rows = [["Workspaces", ...heldList(st ? st.workspaces : undefined)]];
    if (st && st.cost) {
      const c = st.cost;
      rows.push(["Cost", `~$${Number(c.usd_hr).toFixed(2)} an hour · ~$${(c.usd_hr * 24).toFixed(2)} a day`
        + (typeof st.spend_usd === "number" ? ` · ~$${st.spend_usd.toFixed(2)} so far` : ""),
        ctx.el("div", { class: "m", style: "margin-top:.2rem" }, `Estimate: ${c.basis || "on-demand prices"}. Traffic and storage are extra.`)]);
    } else rows.push(["Cost", st ? ctx.el("span", { class: "m" }, "could not be priced — not the same as free") : ctx.el("span", { class: "m" }, "reading…")]);
    if (st && st.ready) {
      const r = st.ready;
      const facts = [];
      if (r.storage_class !== null) facts.push(r.storage_class ? okT(`storage ${r.storage_class}`) : noT("no default storage class"));
      if (r.ingress_class !== null) facts.push(r.ingress_class ? okT(`ingress ${r.ingress_class}`) : noT("no ingress"));
      if (r.cert_manager !== null) facts.push(r.cert_manager ? okT("cert-manager") : noT("no cert-manager"));
      if (st.zone && r.dns_answers === false) facts.push(noT(`public names under ${st.zone} do not answer yet`));
      else if (st.zone) facts.push(`public names under ${st.zone}`);
      else facts.push("no public names yet: workspaces are reached by a port-forward");
      // Saying so was not enough: the record lived only behind the pane's "Public names
      // (DNS)…", which nobody new to EKS knew to open.
      const dnsBtn = (st.zone && r.dns_answers === false) || !st.zone
        ? ctx.el("button", { class: "btn sm", type: "button", style: "margin-left:.6rem", onclick: () => clOpenDns(p.row) }, "Set up DNS")
        : "";
      rows.push(["Ready", ctx.el("span", {}, ...joinDots(facts), dnsBtn)]);
    }
    if (st) {
      const details = [clNodes(st), st.kubernetes_version ? `Kubernetes ${st.kubernetes_version}` : "",
        st.created_at ? `created ${String(st.created_at).slice(0, 10)}` : "",
        st.expires ? `reminder date ${st.expires} (nothing deletes on it)` : "",
        clBuiltBy(p.row, st) === "houston" ? "built by houston" : clBuiltBy(p.row, st) === "you" ? "not built by houston" : ""].filter(Boolean);
      rows.push(["Details", details.join(" · ") || "—"]);
    }
    box.append(kvGrid(rows));
  }
  clPlacePane(p);
}

function clPlacePane(p) {
  const pane = ctx.$("#actpane");
  pane.innerHTML = "";
  if (!p) return;
  const box = ctx.el("div", { class: "ppane" }, ctx.el("h4", {}, p.nm));
  if (createDestOf(p)) {
    box.append(ctx.el("button", { class: "btn solid", type: "button", onclick: () => ctx.openCreate(undefined, { dest: createDestOf(p) }) }, "Create a workspace here"));
  }
  const link = (label, fn, cls = "") => ctx.el("button", { class: "plink " + cls, type: "button", onclick: fn }, label);
  const st = p.context ? CLSTATE.status[p.context] : null;
  if (p.row) {
    const row = p.row;
    const gone = !!(st && st.gone);
    if (p.ico === "aws") {
      if (st && st.reachable) box.append(link("Public names (DNS)…", () => clOpenDns(row)));
      if (ctx.canWrite() && !gone) box.append(link("Prepare again", () => clPrepare(row.context)));
      box.append(link("Copy kubeconfig command", () => clCopy(clKubeconfigCommand(row), "the kubeconfig command")));
    }
    box.append(link("Copy context name", () => clCopy(row.context, "the context name")));
    if (ctx.canWrite() && (gone || (st && !st.reachable))) box.append(link("Forget this cluster", () => clForget(row)));
    if (p.ico === "aws") {
      box.append(ctx.el("hr"));
      if (ctx.canAdmin() && row.billable && !gone && !(st && st.made_by_houston === false)) {
        box.append(link("Delete cluster…", () => clAskDelete(row, st), "danger"),
          ctx.el("p", { class: "note" }, "Deleting stops the charge. Removing workspaces does not."));
      } else if (ctx.canAdmin() && st && st.made_by_houston === false) {
        box.append(ctx.el("p", { class: "note" }, "houston did not build this cluster, so it will not delete it."));
      } else if (!ctx.canAdmin()) {
        box.append(ctx.el("p", { class: "note" }, "Deleting a cluster is an admin action."));
      }
    }
  }
  if (!ctx.canWrite()) box.append(ctx.el("p", { class: "note" }, "Your role is readonly: you can look, not change."));
  pane.append(box);
}

// The overview, read at most once every two minutes whoever asks (Home, the page): one
// EKS status is measured at ~18 s. ONE READ IN FLIGHT: a second caller shares it, and a
// read that failed is not retried for a minute.
let overviewInFlight = null;
let overviewFailedAt = 0;
// `fresh` asks the server to re-read the AWS tools and identity too (`?fresh=1`): a Re-check
// after `aws sso login` or an approval must not be answered from a ten-minute-old read.
async function loadClusterOverview(force = false, { evenWithoutClusters = false, fresh = false } = {}) {
  if (!force && CLSTATE.overview && Date.now() - CLSTATE.overviewAt < 120000) return CLSTATE.overview;
  if (overviewInFlight && fresh) {
    return overviewInFlight.catch(() => null).then(() => loadClusterOverview(true, { evenWithoutClusters, fresh }));
  }
  if (overviewInFlight) return overviewInFlight;
  if (!force && Date.now() - overviewFailedAt < 60000) return CLSTATE.overview;
  if (!CLUSTERS) {
    try { CLUSTERS = await ctx.api("/api/clusters"); } catch (_) { return null; }
  }
  if (!evenWithoutClusters && !(CLUSTERS.contexts || []).length) return null;
  overviewInFlight = ctx.api(`/api/clusters/overview${fresh ? "?fresh=1" : ""}`).then((ov) => {
    CLSTATE.overview = ov;
    CLSTATE.overviewAt = Date.now();
    CLSTATE.overviewError = "";
    for (const st of ov.clusters || []) CLSTATE.status[st.context] = st;
    refreshClusterBadge();
    return ov;
  }, (error) => { overviewFailedAt = Date.now(); CLSTATE.overviewError = error.message; throw error; })
    .finally(() => { overviewInFlight = null; });
  return overviewInFlight;
}

// One cluster re-read, into the same store.
async function clProbe(row) {
  try {
    CLSTATE.status[row.context] = await ctx.api(`/api/clusters/status?context=${encodeURIComponent(row.context)}`);
  } catch (e) {
    CLSTATE.status[row.context] = { context: row.context, reachable: false, gone: false,
      reach_why: e.message, reach_advice: "", unreadable: ["cluster"],
      nodes: null, workspaces: null, pvcs: null, loadbalancers: null, cost: null };
  }
  clRepaint();
}

// Whichever cluster view is on screen, drawn again from what is now known.
function clRepaint() {
  if (ctx.VIEW === "clusters") openClusters();
  else if (ctx.VIEW === "cluster") clRenderPlace(false);
  else refreshClusterBadge();
}

// The rest of a cluster on this machine, read when it is opened rather than on every look.
async function clReadFull(row) {
  if (!row || clWhere(row, CLSTATE.status[row.context]) === "aws") return;
  const st = CLSTATE.status[row.context];
  if (st && !st.reachable) return;
  try {
    CLSTATE.full[row.context] = await ctx.api(`/api/clusters/status?context=${encodeURIComponent(row.context)}`);
  } catch (_) { CLSTATE.full[row.context] = null; }
}

function clKubeconfigCommand(row) {
  const short = clShort(row);
  return String(row.context).startsWith("arn:aws:eks:")
    ? `aws eks update-kubeconfig --name ${short} --region ${row.region}`
    : `kubectl config use-context ${row.context}`;
}

async function clForget(row) {
  // NOT a destroy, so no confirmation dialog: the cluster is already gone and this
  // removes a name from a local file. Red is reserved for "about to destroy something".
  try {
    await ctx.api("/api/clusters/forget",
      { method: "POST", body: JSON.stringify({ context: row.context }) });
    ctx.toast(`forgot ${row.context} — the cluster itself was not touched`, "ok");
    openClusters();
  } catch (e) { ctx.toast(e.message); }
}

async function clPrepare(context) {
  try {
    const { job_id } = await ctx.api("/api/clusters/prepare",
      { method: "POST", body: JSON.stringify({ context }) });
    ctx.streamJob(job_id, `Preparing ${context}`, (res) => {
      ctx.toast(`${context} is ready to serve a workspace`, "ok");
      if (res && res.cname_target) {
        ctx.toast(`point your name at ${res.cname_target}`, "ok");
      } else if (res && res.cname_pending) {
        ctx.toast("the load balancer has no address yet — prepare again in a minute");
      } else if (res) {
        ctx.toast("no load balancer is waiting for an address — this cluster has no "
              + "load-balancing ingress, so workspaces here reach you by port-forward");
      }
      CLSTATE.overview = null;
      loadClusterOverview(true, { evenWithoutClusters: true }).catch(() => {}).then(clRepaint);
    });
  } catch (e) { ctx.toast(e.message); }
}

async function clCopy(text, what) {
  try { await navigator.clipboard.writeText(text); ctx.toast(`${what} copied`, "ok"); }
  catch (_) { ctx.toast("could not reach the clipboard"); }
}

async function clCopyDoc(name) {
  try {
    const r = await ctx.api(`/api/clusters/iam-policy?name=${encodeURIComponent(name)}`);
    await clCopy(r.documents[0].body, `${name} document`);
  } catch (e) { ctx.toast(e.message); }
}

// ---- Set up Amazon EKS: one guided path ----------------------------------------
// ① AWS on the server -- the tools and the identity the AWS CLI finds there; keys are
// never typed into this page -- ② build a cluster, or check the account for one houston
// built, ③ ready. Every call is the one the CLI makes: connection, sweep, connect, approve,
// estimate, create.
const SETUP = { step: 1, back: false, branch: "build", sweeping: false, sweep: null, sweepError: "",
  connected: null, connectedStatus: undefined, building: "", estimate: null, checking: false, checkedAt: 0,
  f: { name: "", region: "", nodes: 3, expires: "7", zone: "", email: "" } };

async function openEksSetup() {
  Object.assign(SETUP, { step: 1, back: false, branch: "build", sweeping: false, sweep: null, sweepError: "",
    connected: null, connectedStatus: undefined, building: "", estimate: null, checking: false, checkedAt: 0,
    f: { name: "", region: "", nodes: 3, expires: "7", zone: "", email: "" } });
  const dialog = ctx.$("#eks-setup");
  renderSetup(true);
  if (!dialog.open) dialog.showModal();
  await setupRecheck(false);
}

// Seen to happen: an answer that has not changed redrew the same screen, so a Re-check
// looked like a button that did nothing.
async function setupRecheck(force = true) {
  SETUP.checking = true;
  if (SETUP.step === 1 && ctx.$("#eks-setup").open) renderSetup(false);
  try {
    await Promise.all([clReadConnection(force),
      loadClusterOverview(force, { evenWithoutClusters: true, fresh: force }).catch(() => null)]);
  } finally {
    SETUP.checking = false;
    SETUP.checkedAt = Date.now();
  }
  if (ctx.$("#eks-setup").open) renderSetup(false);
}

function setupGo(step, back = false) {
  SETUP.step = step;
  SETUP.back = back;
  renderSetup(true);
  if (step === 2 && !SETUP.estimate) setupPrice();
}

function setupPre() {
  return (CLSTATE.overview && CLSTATE.overview.preflight) || null;
}

function renderSetup(anim) {
  const steps = ctx.$("#eks-steps");
  steps.innerHTML = "";
  ["Connect AWS", "Choose a cluster", "Ready"].forEach((label, i) => {
    const at = i + 1;
    const cls = at < SETUP.step ? "done" : at === SETUP.step ? "on" : "";
    if (i) steps.append(ctx.el("span", { class: "ln" }));
    steps.append(ctx.el("span", { class: cls }, ctx.el("i", {}, cls === "done" ? "✓" : String(at)), label));
  });
  const body = ctx.$("#eks-body");
  const keep = anim ? 0 : body.scrollTop;
  body.innerHTML = "";
  const step = ctx.el("section", { class: "wzd-step" + (anim ? " anim" : "") + (anim && SETUP.back ? " back" : "") });
  body.append(step);
  const foot = ctx.$("#eks-foot");
  foot.innerHTML = "";
  if (SETUP.step === 1) setupStepOne(step, foot);
  else if (SETUP.step === 2) setupStepTwo(step, foot);
  else setupStepThree(step, foot);
  body.scrollTop = keep;
  if (anim) { const q = step.querySelector(".wzd-q"); if (q) q.focus({ preventScroll: true }); }
}

const sq = (cls, mark) => ctx.el("span", { class: `s ${cls}` }, mark);
const fbtn = (label, onclick, cls = "btn", disabled = false) => {
  const b = ctx.el("button", { type: "button", class: cls, onclick }, label);
  b.disabled = disabled;
  return b;
};
const fhint = (text) => ctx.el("span", { class: "hint wzd-hint" }, text);

function setupStepOne(step, foot) {
  const pre = setupPre();
  const s = awsSignIn();
  step.append(ctx.el("p", { class: "wzd-q", tabindex: "-1" }, "Connect AWS on the server"),
    ctx.el("p", { class: "hint", style: "margin:-.4rem 0 1rem;font-size:14px" },
      "Houston uses the AWS identity of the machine it runs on. Everyone using this page acts as that one identity, "
      + "and the audit log records who clicked. Houston never asks for AWS keys here."));
  const list = ctx.el("ul", { class: "checklist" });
  if (!pre && CLSTATE.overviewError) {
    list.append(ctx.el("li", {}, sq("n", "!"), ctx.el("span", {}, "Couldn't check the server's tools: ",
      ctx.el("span", { class: "m" }, CLSTATE.overviewError))));
  } else if (!pre) list.append(ctx.el("li", {}, sq("run", "·"), ctx.el("span", {}, "Checking the server…")));
  else {
    const blockers = pre.blockers || [];
    const toolMissing = ["aws", "kubectl", "helm"].filter((t) => blockers.some((b) => b.startsWith(`${t} `)));
    list.append(ctx.el("li", {}, toolMissing.length ? sq("n", "!") : sq("y", "✓"),
      ctx.el("span", {}, "Tools on the server: aws, kubectl, helm",
        toolMissing.length ? ctx.el("span", { class: "warn" }, ` (missing: ${toolMissing.join(", ")}; houston doctor names what to install)`) : "")));
    const eksctl = !blockers.some((b) => b.startsWith("eksctl "));
    list.append(ctx.el("li", {}, eksctl ? sq("y", "✓") : sq("w", "–"),
      ctx.el("span", {}, "eksctl", eksctl ? "" : ctx.el("span", { class: "m" }, " not installed; only needed to build a new cluster"))));
  }
  if (s.state === "unknown") list.append(ctx.el("li", {}, sq("run", "·"), ctx.el("span", {}, "Asking AWS who this server is…")));
  else if (s.state === "signed") {
    list.append(ctx.el("li", {}, sq("y", "✓"), ctx.el("span", {}, "Signed in as ", ctx.el("b", {}, s.name),
      s.kind ? ` (${s.kind})` : "", ` · account ${s.account}`, s.region ? ` · ${s.region}` : "")));
  } else {
    list.append(ctx.el("li", {}, sq("n", "!"), ctx.el("span", {},
      s.state === "expired" ? "The server's AWS SSO sign-in has expired." : "The server isn't signed in to AWS.",
      s.error ? ctx.el("span", { class: "m" }, ` ${s.error.replace(/^not signed in to AWS \(|\)$/gu, "")}`) : "")));
  }
  step.append(list);
  const cmdBox = (text) => ctx.el("div", { class: "cmd" }, ctx.el("pre", {}, text),
    ctx.el("button", { type: "button", class: "btn sm", onclick: () => clCopy(text, "the commands") }, "Copy"));
  if (s.state === "expired") {
    const profile = s.profile || "<profile>";
    step.append(ctx.el("div", { class: "way" }, ctx.el("h4", {}, "Sign in again on the server"),
      ctx.el("p", {}, "Run this as the user that runs Houston, then Re-check."), cmdBox(`aws sso login --profile ${profile}`)));
  } else if (s.state === "none") {
    // The commonest cause: `aws` works in a shell that has AWS_PROFILE and the server was
    // started from one that did not. Re-checking cannot fix that; a restart can.
    if (!s.profile && s.profiles.length) {
      const profile = s.profiles.length === 1 ? s.profiles[0] : "<profile>";
      step.append(ctx.el("div", { class: "way", id: "eks-profiles", style: "margin-bottom:.7rem" },
        ctx.el("h4", {}, "This server was started without AWS_PROFILE"),
        ctx.el("p", {}, "Its AWS config has ", ctx.el("b", {}, s.profiles.join(", ")),
          ". Restart houston serve with AWS_PROFILE set to the one that can use EKS. Running it as a service? "
          + "Print the unit again with houston serve --print-service from a shell that has it set."),
        cmdBox(`AWS_PROFILE=${profile} houston serve`)));
    }
    step.append(ctx.el("p", { style: "margin:.2rem 0 .7rem" }, "On the server, use one of these, then Re-check:"),
      ctx.el("div", { class: "ways" },
        ctx.el("div", { class: "way" }, ctx.el("h4", {}, "Company SSO ", ctx.el("span", { class: "tag" }, "Recommended")),
          ctx.el("p", {}, "Set up a profile once; sign in again when it expires."),
          cmdBox("aws configure sso --profile support-eks\naws sso login --profile support-eks\nAWS_PROFILE=support-eks houston serve")),
        ctx.el("div", { class: "way" }, ctx.el("h4", {}, "Server role"),
          ctx.el("p", {}, "For a shared server: attach an instance, container or workload role with the EKS permissions. Nothing to sign in to.")),
        ctx.el("details", { class: "way" }, ctx.el("summary", {}, "Access keys"),
          ctx.el("p", { style: "margin-top:.4rem" }, "Only if SSO or a role isn't available: set AWS_ACCESS_KEY_ID and "
            + "AWS_SECRET_ACCESS_KEY (plus AWS_SESSION_TOKEN for temporary keys) in the server's environment. "
            + "Don't paste keys into this page."))));
  } else if (s.state === "signed" && ctx.canAdmin()) {
    step.append(ctx.el("details", { class: "way", style: "margin-top:.6rem" }, ctx.el("summary", {}, "Permissions for colleagues"),
      ctx.el("p", { style: "margin:.4rem 0 .6rem" }, "IAM decides who may build. Each person who runs workspaces also needs an EKS access entry on the cluster."),
      ctx.el("div", { style: "display:flex;gap:.5rem;flex-wrap:wrap" },
        ...[["operator", "Copy operator policy"], ["engineer", "Copy engineer policy"], ["rbac", "Copy engineer RBAC"]]
          .map(([key, label]) => fbtn(label, () => clCopyDoc(key), "btn sm")))));
  }
  const signed = s.state === "signed";
  const checked = SETUP.checkedAt ? ` Checked at ${new Date(SETUP.checkedAt).toLocaleTimeString()}.` : "";
  foot.append(fbtn("Cancel", () => ctx.$("#eks-setup").close()),
    fhint(signed ? "" : `Re-check after signing in on the server.${checked}`));
  if (!signed || !pre) foot.append(fbtn(SETUP.checking ? "Checking…" : "Re-check", () => setupRecheck(true), "btn", SETUP.checking));
  foot.append(fbtn("Next →", () => setupGo(2), "btn solid", !signed));
}

function setupStepTwo(step, foot) {
  const read = setupPre();
  const pre = read || { approved: false, account: "", region: "", blockers: [] };
  const s = awsSignIn();
  const account = s.account || pre.account || "";
  const existing = SETUP.branch === "existing";
  step.append(ctx.el("p", { class: "wzd-q", tabindex: "-1" }, "Choose a cluster"));
  const choice = (value, title, why) => {
    const input = ctx.el("input", { type: "radio", name: "eks_branch", value });
    input.checked = SETUP.branch === value;
    input.addEventListener("change", () => { SETUP.branch = value; renderSetup(false); if (value === "build" && !SETUP.estimate) setupPrice(); });
    return ctx.el("label", { class: "choice" }, input, ctx.el("div", {}, ctx.el("b", {}, title), ctx.el("span", {}, why)));
  };
  const day = SETUP.estimate ? `About $${Number(SETUP.estimate.usd_day).toFixed(2)} a day` : "It bills by the hour";
  step.append(choice("build", "Build a new cluster", `About 20 minutes. ${day} from the first minute until someone deletes it.`));
  if (!existing) {
    const sub = ctx.el("div", { style: "margin:0 0 1rem 2rem" });
    if (!read) {
      sub.append(ctx.el("div", { class: "callout money", style: "margin-top:0" },
        `Couldn't read whether account ${account} is approved for spending here${CLSTATE.overviewError ? `: ${CLSTATE.overviewError}` : ""}. Re-check on step 1.`));
    } else if (!pre.approved) {
      // The certificate contact goes with the approval, so it is asked for here.
      const email = ctx.el("input", { name: "eks_email", type: "email", placeholder: "you@example.com", value: SETUP.f.email, autocomplete: "off" });
      email.addEventListener("input", () => { SETUP.f.email = email.value.trim(); });
      sub.append(ctx.el("div", { class: "callout money", style: "margin-top:0" },
        `Account ${account} isn't approved for spending on this server. Approving lets anyone with the admin role build clusters here; it is recorded in the audit log.`,
        ctx.el("label", { class: "f", style: "margin-top:.6rem" }, "Contact email for certificates (optional)", email),
        ctx.el("div", { style: "margin-top:.5rem" }, fbtn(`Approve account ${account}`, () => setupApprove(account), "btn sm", !account || !ctx.canAdmin()))));
    }
    const eksctl = !(pre.blockers || []).some((b) => b.startsWith("eksctl "));
    if (!eksctl) sub.append(ctx.el("div", { class: "callout money" }, "eksctl isn't installed on the server, and a build needs it. Install it, then Re-check on step 1."));
    if (!SETUP.f.region) SETUP.f.region = s.region || pre.region || "";
    const field = (label, key, attrs = {}, hint = "") => {
      const input = ctx.el("input", { name: `eks_${key}`, value: String(SETUP.f[key] ?? ""), autocomplete: "off", ...attrs });
      input.addEventListener("input", () => {
        SETUP.f[key] = input.value.trim();
        if (key === "nodes") setupPrice();
        const go = ctx.$("#eks-build-go");
        if (go) go.disabled = !setupCanBuild();
      });
      return ctx.el("div", {}, ctx.el("label", { class: "f" }, label, input), hint ? ctx.el("p", { class: "hint" }, hint) : "");
    };
    sub.append(ctx.el("div", { class: "two", style: "margin-top:.9rem" },
      field("Name", "name", { placeholder: "team-eks" }), field("Region", "region", { placeholder: "us-east-1" }),
      field("Nodes", "nodes", { type: "number", min: "1", max: "20" }),
      field("Reminder to delete, in days", "expires", { placeholder: "7" }, "A reminder only: nothing deletes on it."),
      field("Public names (optional)", "zone", { placeholder: "eks.example.com" })));
    const est = SETUP.estimate;
    const estBox = ctx.el("div", { class: "callout info", id: "eks-estimate" });
    if (est) {
      estBox.append("Estimate: ", ctx.el("b", {}, `~$${Number(est.usd_hr).toFixed(2)} an hour · ~$${Number(est.usd_day).toFixed(2)} a day · ~$${Math.round(est.usd_day * 30.4)} a month`),
        `. ${est.basis || "On-demand prices"}; traffic and storage are extra.`);
    } else estBox.append("Pricing…");
    sub.append(estBox);
    step.append(sub);
  }
  // SECOND, and only what houston built up front: an AWS account is usually the company's,
  // and most EKS clusters a search finds there are somebody's production, not a place for
  // a test workspace. "Use a cluster your team already runs" read as an invitation to them.
  step.append(choice("existing", "Check for a cluster houston already built",
    `Looks through account ${account || "on the server"} for EKS clusters built with houston. Connecting one is free.`));
  if (existing) {
    const sub = ctx.el("div", { style: "margin:0 0 0 2rem" });
    if (SETUP.sweeping) sub.append(ctx.el("ul", { class: "checklist" }, ctx.el("li", {}, sq("run", "·"),
      ctx.el("span", {}, `Searching the enabled AWS regions of account ${account}… about twenty seconds.`))));
    else if (SETUP.sweepError) sub.append(ctx.el("div", { class: "zerr" }, ctx.el("span", {}, SETUP.sweepError),
      fbtn("Try again", () => setupSweep(), "btn sm")));
    else if (SETUP.sweep) {
      const known = new Set(((CLUSTERS && CLUSTERS.contexts) || []).map((r) => r.context));
      const row = (c) => {
        const have = known.has(c.arn);
        return ctx.el("div", { class: "drow", "data-swept": c.name },
          ctx.el("div", { class: "grow" }, ctx.el("div", { class: "t" }, c.name),
            ctx.el("div", { class: "m" }, [c.region, (c.status || "?").replace(/^ACTIVE$/u, "Active"),
              c.ours ? "built with houston" : "not built with houston"].join(" · "))),
          have ? ctx.el("span", { class: "m" }, "Connected")
            : fbtn("Connect", () => setupConnect(c), "btn sm", !c.arn || (c.status && c.status !== "ACTIVE")));
      };
      const all = SETUP.sweep.clusters || [];
      const ours = all.filter((c) => c.ours);
      const others = all.filter((c) => !c.ours);
      if (ours.length) sub.append(ctx.el("div", { class: "found" }, ...ours.map(row)));
      else sub.append(ctx.el("p", { class: "hint", style: "font-size:13px" },
        `No cluster built with houston in account ${account}. Build one above.`));
      if (others.length) {
        sub.append(ctx.el("details", { class: "adv", id: "eks-others", style: "margin-top:.6rem" },
          ctx.el("summary", {}, `${ctx.plural(others.length, "other EKS cluster")} in this account, not built with houston`),
          ctx.el("p", { class: "m", style: "margin:.4rem 0" },
            "These belong to someone else in the account, often the company's own systems. Connect one only if it is meant for testing."),
          ctx.el("div", { class: "found" }, ...others.map(row))));
      }
      const bad = (SETUP.sweep.unreadable || []).length;
      sub.append(ctx.el("p", { class: "m", style: "margin-top:.4rem" },
        `Searched ${(SETUP.sweep.regions || []).length} regions in account ${account}.`
        + (bad ? ` ${bad} region${bad === 1 ? "" : "s"} could not be read, so this list may be missing a cluster.` : "")));
    } else sub.append(fbtn(`Check account ${account}`, () => setupSweep()));
    step.append(sub);
  }
  foot.append(fbtn("← Back", () => setupGo(1, true)),
    fhint(existing ? "Connect a cluster from the list." : "It starts billing as soon as the build starts."));
  if (!existing) {
    const go = fbtn("Build it: starts billing", () => setupBuild(), "btn solid", !setupCanBuild());
    go.id = "eks-build-go";
    foot.append(go);
  }
}

function setupCanBuild() {
  const pre = setupPre() || {};
  const eksctl = !(pre.blockers || []).some((b) => b.startsWith("eksctl "));
  return !!(setupPre() && pre.approved && eksctl && SETUP.f.name && ctx.canAdmin());
}

async function setupPrice() {
  const nodes = Number(SETUP.f.nodes) || 3;
  try {
    const r = await ctx.api(`/api/clusters/estimate?nodes=${encodeURIComponent(nodes)}`);
    if ((Number(SETUP.f.nodes) || 3) !== nodes) return;      // a newer value is on its way
    SETUP.estimate = r;
  } catch (e) { SETUP.estimate = null; const box = ctx.$("#eks-estimate"); if (box) box.textContent = e.message; return; }
  if (ctx.$("#eks-setup").open && SETUP.step === 2) {
    const focus = document.activeElement && document.activeElement.name;
    renderSetup(false);
    if (focus) { const el = ctx.$(`#eks-body [name="${focus}"]`); if (el) { el.focus(); const v = el.value; el.value = ""; el.value = v; } }
  }
}

async function setupSweep() {
  SETUP.sweeping = true; SETUP.sweepError = ""; SETUP.sweep = null;
  renderSetup(false);
  try {
    const { job_id } = await ctx.api("/api/clusters/sweep", { method: "POST", body: JSON.stringify({ all: true }) });
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const state = await ctx.api(`/api/jobs/${job_id}`);
      if (ctx.jobActive(state.status)) continue;
      if (state.status === "error") throw new Error(state.error || "the search failed");
      SETUP.sweep = state.result || { clusters: [], regions: [] };
      break;
    }
  } catch (e) { SETUP.sweepError = e.message; }
  SETUP.sweeping = false;
  if (ctx.$("#eks-setup").open) renderSetup(false);
}

async function setupConnect(cluster) {
  if (!ctx.canAdmin()) { ctx.toast("An administrator connects clusters on the Houston server."); return; }
  try {
    const result = await ctx.api("/api/clusters/connect", { method: "POST", body: JSON.stringify({ context: cluster.arn }) });
    SETUP.connected = { name: cluster.name, region: cluster.region, context: result.context,
      reachable: !!result.reachable, access_reason: result.access_reason || "" };
    SETUP.connectedStatus = undefined;
    setupGo(3);
    CLSTATE.overview = null;
    try { CLUSTERS = await ctx.api("/api/clusters"); clSyncRows(); } catch (_) { /* the page re-reads on open */ }
    try { SETUP.connectedStatus = await ctx.api(`/api/clusters/status?context=${encodeURIComponent(result.context)}`); }
    catch (_) { SETUP.connectedStatus = null; }
    if (SETUP.connectedStatus) CLSTATE.status[result.context] = SETUP.connectedStatus;
    if (ctx.$("#eks-setup").open && SETUP.step === 3) renderSetup(false);
    if (ctx.VIEW === "clusters") openClusters();
  } catch (e) { ctx.toast(e.message); }
}

async function setupApprove(account) {
  try {
    await ctx.api("/api/clusters/approve", { method: "POST", body: JSON.stringify({ account, acme_email: SETUP.f.email || "" }) });
    ctx.toast(`Account ${account} approved for spending on this server. Recorded in the audit log.`, "ok");
    await setupRecheck(true);
  } catch (e) { ctx.toast(e.message); }
}

async function setupBuild() {
  const name = (SETUP.f.name || "").trim();
  if (!name) { ctx.toast("The cluster needs a name, e.g. team-eks"); return; }
  const body = { name, region: SETUP.f.region, nodes: Number(SETUP.f.nodes) || 0, expires: SETUP.f.expires, zone: SETUP.f.zone };
  try {
    const { job_id } = await ctx.api("/api/clusters/create", { method: "POST", body: JSON.stringify(body) });
    SETUP.building = name;
    CLSTATE.jobs = [...CLSTATE.jobs, { id: job_id, kind: "cluster-create", label: name, status: "running", started_at: Date.now() / 1000 }];
    setupGo(3);
    // It runs on without this dialog: the Clusters page shows it as a building card,
    // and the toast says how it ended.
    const zone = SETUP.f.zone;
    ctx.watchDetachedJob({ id: job_id, title: `Building ${name}` }).then((state) => {
      CLSTATE.overview = null;
      if (ctx.VIEW === "clusters") openClusters();
      if (state && state.status !== "error" && zone) {
        ctx.toast(`${name} is ready. One step left: its DNS record — Set up DNS on its card.`, "info");
      }
    });
    if (ctx.VIEW === "clusters") openClusters();
  } catch (e) { ctx.toast(e.message); }
}

function setupStepThree(step, foot) {
  if (SETUP.building) {
    step.append(ctx.el("p", { class: "wzd-q", tabindex: "-1" }, `${SETUP.building} is being built`),
      ctx.el("div", { class: "progress", style: "margin:.4rem 0 1rem" }, ctx.el("i", { style: "width:6%" })),
      ctx.el("p", { class: "hint", style: "font-size:14px" }, "About 20 minutes. You can close this: the Clusters page shows its progress, "
        + "and it appears as a place to run workspaces when it is ready."),
      // Said BEFORE it is needed: nothing told a first-time user a built cluster wants a DNS record.
      ctx.el("p", { class: "hint", style: "font-size:14px" }, SETUP.f.zone
        ? `Then one step is left: one DNS record, so its workspaces get public names under ${SETUP.f.zone}. `
          + "Home and the cluster's card show it, with a Set up button."
        : "Without a DNS zone its workspaces are reachable only by a port-forward; the cluster's page says how to add one."));
    foot.append(fhint(""), fbtn("Close", () => ctx.$("#eks-setup").close(), "btn solid"));
    return;
  }
  const c = SETUP.connected || {};
  const st = SETUP.connectedStatus;
  step.append(ctx.el("p", { class: "wzd-q", tabindex: "-1" }, `${c.name || "The cluster"} is connected`));
  const list = ctx.el("ul", { class: "checklist" });
  list.append(ctx.el("li", {}, c.reachable ? sq("y", "✓") : sq("n", "!"),
    ctx.el("span", {}, c.reachable ? `${c.name} answers from this server` : `${c.name} does not let this server in yet: ${c.access_reason || "access denied"}`)));
  if (st === undefined) list.append(ctx.el("li", {}, sq("run", "·"), ctx.el("span", {}, "Checking what it has…")));
  else if (st && st.ready) {
    const r = st.ready;
    const ready = r.storage_class && r.ingress_class && r.cert_manager;
    list.append(ctx.el("li", {}, ready ? sq("y", "✓") : sq("n", "!"),
      ctx.el("span", {}, ready ? "Storage, ingress and certificates are ready"
        : "Not prepared yet: Prepare installs the ingress and certificates workspaces need",
        !ready && ctx.canWrite() ? ctx.el("span", {}, " ", fbtn("Prepare it", () => clPrepare(c.context), "btn sm")) : "")));
  }
  step.append(list);
  const target = st && st.ready && st.ready.cname_target;
  if (target || (st && st.zone)) {
    const record = `*.${(st && st.zone) || "<your zone>"}   CNAME   ${target || "<the load balancer's address, once it has one>"}`;
    step.append(ctx.el("div", { class: "way" }, ctx.el("h4", {}, "Public names ", ctx.el("span", { class: "pill off" }, "Optional")),
      ctx.el("p", {}, `Without them, workspaces on ${c.name} are reachable only by a port-forward from the server. Add one DNS record:`),
      ctx.el("div", { class: "cmd" }, ctx.el("pre", {}, record), fbtn("Copy", () => clCopy(record, "the record"), "btn sm"))));
  }
  foot.append(fhint(""), fbtn("Close", () => ctx.$("#eks-setup").close()));
  if (ctx.canWrite() && c.context) {
    foot.append(fbtn(`Create a workspace on ${c.name}`, () => {
      ctx.$("#eks-setup").close();
      ctx.openCreate(undefined, { dest: `eks:${c.context}` });
    }, "btn solid", !c.reachable));
  }
}

// ---- a cluster's public names ---------------------------------------------------
// Its DNS zone and the load balancer to point it at, from the cluster's own view.
const BUILD = { name: "", zone: "", target: "", region4: "" };

const chk = (ok, ...text) => ctx.el("div", { class: "chk" },
  ctx.el("span", { class: ok ? "ok" : "no" }, ok ? "✓" : "✗"), ctx.el("span", {}, ...text));

function sameIn(command) {
  return ctx.el("div", { class: "same" }, ctx.el("span", {}, "Same in the terminal:"),
    cmdCode(command),
    ctx.el("button", { type: "button", class: "cp", onclick: () => clCopy(command, "the command") }, "copy"));
}

function btn(label, onclick, { primary = false, disabled = false } = {}) {
  const b = ctx.el("button", { type: "button", class: "btn" + (primary ? " solid" : ""), onclick }, label);
  if (disabled) b.disabled = true;
  return b;
}

// One record, laid out the way a DNS provider's form asks for it. The one-line
// "*.zone CNAME target" left a first-time user to work out that Cloudflare wants only the
// part before the domain (typing "*" made *.example.com, every name on the domain), that
// its proxy must be off (it defaults on, and warns when turned off), and that
// houston-probe is a test name, not a record to create -- all three happened.
function clDnsNames(zone) {
  // The registered domain: the last two labels, or three under a two-part suffix such as
  // co.uk or com.au. ponytail: a heuristic, not the public suffix list; it only words a hint.
  const labels = zone.split(".");
  const twoPart = labels.length > 2 && /^[a-z]{2}$/u.test(labels.at(-1)) && /^(co|com|net|org|gov|ac|edu)$/u.test(labels.at(-2));
  const apex = labels.slice(twoPart ? -3 : -2).join(".");
  return { apex, rel: zone === apex ? "*" : `*.${zone.slice(0, -apex.length - 1)}` };
}

function clRenderDns() {
  const body = ctx.$("#cluster-build-body");
  const menu = ctx.$("#cluster-build-menu");
  ctx.$("#cluster-build-title").textContent = `Public names for ${BUILD.name}`;
  ctx.$("#cluster-build-steps").innerHTML = "";
  body.innerHTML = ""; menu.innerHTML = "";
  const zone = BUILD.zone;
  menu.append(btn("Close", () => ctx.$("#cluster-build").close()));
  if (!zone) {
    body.append(ctx.el("p", { class: "hint" }, "This cluster has no DNS zone, so a workspace on it is reachable only "
      + "by a port-forward from the machine that made it. Give it a zone, a domain you control such as "
      + "rc.example.com, and every workspace is named <name>.<zone>; then add the one record this shows."),
      sameIn(`houston cluster prepare ${BUILD.name} --zone <zone>`));
    return;
  }
  const { apex, rel } = clDnsNames(zone);
  const target = BUILD.target || "<the load balancer's address, once it has one>";
  body.append(ctx.el("p", { class: "hint" }, `Workspaces on this cluster are named <name>.${zone}. Add this one record `
    + "at your DNS provider, once:"));
  body.append(kvGrid([
    ["Type", ctx.el("b", {}, "CNAME"), ctx.el("span", { class: "m" }, " — not an A record: the load balancer's addresses change")],
    ["Name", ctx.el("code", {}, `*.${zone}`), ctx.el("div", { class: "m" }, "Cloudflare and most providers want only the part "
      + `before your domain: if your domain is ${apex}, type `, ctx.el("code", {}, rel), ".")],
    ["Target", ctx.el("code", {}, target), " ", ctx.el("button", { type: "button", class: "cp", onclick: () => clCopy(target, "the target") }, "copy")],
    ["Proxy", ctx.el("b", {}, "DNS only"), ctx.el("div", { class: "m" }, "At Cloudflare, the grey cloud. Ignore its warning that this "
      + "exposes your origin: the target is a public AWS load balancer, and the proxy would take over HTTPS, so the "
      + "workspaces' certificates fail.")],
  ]));
  body.append(ctx.el("p", { class: "hint" }, "houston checks it by looking up ", ctx.el("code", {}, `houston-probe.${zone}`),
    ", a name you do not create: the record above answers for it."));
  body.append(ctx.el("div", { id: "cluster-build-dns", class: "chk-slot" }));
  body.append(sameIn(`dig +short houston-probe.${zone} CNAME @1.1.1.1`));
  menu.append(btn("Check DNS", () => clBuildCheckDns()));
}

async function clBuildCheckDns() {
  const slot = ctx.$("#cluster-build-dns");
  if (!slot || !BUILD.zone) return;
  const host = `houston-probe.${BUILD.zone}`;
  slot.innerHTML = "";
  slot.append(ctx.el("span", { class: "muted" }, `asking for ${host}…`));
  try {
    const r = await ctx.api(`/api/clusters/dns-check?host=${encodeURIComponent(host)}&target=${encodeURIComponent(BUILD.target)}`);
    slot.innerHTML = "";
    if (r.matches) slot.append(chk(true, `${host} answers — it reaches the cluster`));
    else if (r.answers && r.answers.length) slot.append(chk(false, `${host} points at ${r.answers.join(", ")}, not at the cluster`));
    else if (r.addresses && r.addresses.length) {
      slot.append(chk(false, `${host} answers with addresses (${r.addresses.join(", ")}) but not the CNAME: the record is `
        + "proxied (at Cloudflare, set it to DNS only, the grey cloud) or it is an A record (make it a CNAME)."));
    } else {
      slot.append(chk(false, `${host} does not answer yet. Check the record's name is *.${BUILD.zone} `
        + `(${clDnsNames(BUILD.zone).rel} at Cloudflare); a new record takes a few minutes.`));
    }
  } catch (e) { slot.innerHTML = ""; slot.append(chk(false, e.message)); }
}

function clOpenDns(row) {
  const st = CLSTATE.status[row.context] || {};
  Object.assign(BUILD, { name: clShort(row), region4: st.region || row.region || "",
    zone: st.zone || "", target: (st.ready && st.ready.cname_target) || "" });
  clRenderDns();
  ctx.$("#cluster-build").showModal();
}

function clJobResultBox(lines) {
  const pre = ctx.$("#job-log");
  if (!pre) return;
  const box = ctx.el("div", { class: "result" }, ctx.el("div", { html: "<hr>" }));
  for (const [text, cls] of lines) box.append(ctx.el("div", { class: cls || "" }, ...codeText(text)));
  pre.append(box);
  pre.scrollTop = pre.scrollHeight;
}

function renderClusterDeleteResult(r) {
  if (!r || typeof r !== "object") return;
  const left = r.leftovers || { found: [], unreadable: [] };
  const region = r.region || "the region";
  const lines = [];
  if (!(left.found || []).length && !(left.unreadable || []).length) {
    lines.push([`nothing in ${region} is billing — AWS holds no volume, load balancer, NAT gateway, address or stack of it`, "ok"]);
  } else {
    // Tied to this cluster by a tag: with the command. Not tied: to check, without one.
    const tied = (left.found || []).filter((row) => row.certain !== false);
    const loose = (left.found || []).filter((row) => row.certain === false);
    if (tied.length) lines.push([`left behind in ${region} — each one bills until it is removed:`, "warn"]);
    for (const row of tied) {
      lines.push([`  ${row.kind}  ${row.id}  ${row.detail || ""}`]);
      lines.push([`    \`${row.fix}\``]);
    }
    if (loose.length) lines.push([`in ${region}, not tied to this cluster by any tag — check before deleting:`, "warn"]);
    for (const row of loose) lines.push([`  ${row.kind}  ${row.id}  ${row.detail || ""}`]);
    for (const row of left.unreadable || []) {
      lines.push([`  ${row.kind}: could not be read (${row.why}) — check it in AWS`, "warn"]);
    }
  }
  lines.push(["next: `houston cluster list` checks every region, so nothing is missed"]);
  clJobResultBox(lines);
}

function renderClusterCreateResult(r) {
  if (!r || typeof r !== "object") return;
  const prepared = r.prepared || {};
  const lines = [[`cluster ${r.name || ""} is up in ${r.region || ""}`, "ok"]];
  if (prepared.cname_target) {
    lines.push([`next: point *.${prepared.zone || "<your zone>"} at ${prepared.cname_target} (a CNAME, once, at your DNS provider)`]);
  }
  lines.push([`then click New workspace and pick ${r.name || "the cluster"} under Where it runs`]);
  clJobResultBox(lines);
}

function renderClusterSweepResult(r) {
  if (!r || typeof r !== "object") return;
  const lines = [[`${(r.regions || []).length} region(s) swept, ${(r.clusters || []).length} cluster(s) found`]];
  for (const c of r.clusters || []) {
    lines.push([`  ${c.region}  ${c.name}  ${c.status || "?"}${c.expires ? ` · expires ${c.expires}` : ""}${c.ours ? "" : " · not houston's"}`]);
  }
  for (const bad of r.unreadable || []) {
    lines.push([`  ${bad.region} could NOT be read (${bad.why}) — this report does not cover it`, "warn"]);
  }
  clJobResultBox(lines);
}

function clAskDelete(row, st) {
  const name = row.context.split("/").pop();
  CLSTATE.deleting = name;
  // The ROW, for its region: the request carried only the name, the server looked in the
  // AWS CLI's default region, found nothing, and the dialog said "Done" over a cluster
  // that billed on in eu-west-1.
  CLSTATE.deletingRow = row;
  ctx.$("#cluster-delete-what").textContent =
    `${name} — this destroys the cluster, its VPC and everything in it. It cannot be undone.`;
  const holds = ctx.$("#cluster-delete-holds");
  holds.innerHTML = "";
  if (st && st.workspaces && st.workspaces.length) {
    holds.append(ctx.el("p", { class: "cl-warn" },
      `It is holding ${st.workspaces.length} workspace(s): `
      + st.workspaces.map((w) => `${w.name} (${w.owner || "unowned"})`).join(", ")
      + ". The delete will refuse unless you force it — and on a shared cluster those "
      + "owners may be colleagues on other machines."));
  } else if (!st || !st.reachable) {
    holds.append(ctx.el("p", { class: "cl-warn" },
      "What it holds could not be read, which is not the same as it being empty."));
  }
  const form = ctx.$("#cluster-delete-form");
  form.reset();
  ctx.$("#cluster-delete-go").disabled = true;
  form.confirm.oninput = () => {
    ctx.$("#cluster-delete-go").disabled = form.confirm.value.trim() !== name;
  };
  ctx.$("#cluster-delete-dialog").showModal();
}

async function clSubmitDelete(ev) {
  ev.preventDefault();
  const form = ctx.$("#cluster-delete-form");
  const name = CLSTATE.deleting;
  if (!name || form.confirm.value.trim() !== name) return;
  const force = !!form.force.checked;
  ctx.$("#cluster-delete-dialog").close();
  try {
    const { job_id } = await ctx.api("/api/clusters/delete",
      { method: "POST", body: JSON.stringify({ name, force,
        region: (CLSTATE.deletingRow && CLSTATE.deletingRow.region) || "" }) });
    ctx.streamJob(job_id, `Deleting ${name}`, (res) => {
      renderClusterDeleteResult(res);
      ctx.toast(`cluster ${name} is gone`, "ok");
      delete CLSTATE.status[name];
      openClusters();
    });
  } catch (e) { ctx.toast(e.message); }
}

ctx.$("#edge-close").addEventListener("click", () => ctx.$("#edge-dialog").close());
// The Access note follows BOTH things it talks about: which cluster, and whether a
// name has been given.
ctx.$("#context-select").addEventListener("change", ctx.syncClusterNote);
ctx.$("#create-form").domain.addEventListener("input", ctx.syncClusterNote);
ctx.$("#cluster-badge").addEventListener("click", () => openClusters());
// Enter in a field must not close a flow: every step moves by its own buttons.
ctx.$("#cluster-build-form").addEventListener("submit", (ev) => ev.preventDefault());
ctx.$("#eks-form").addEventListener("submit", (ev) => ev.preventDefault());
ctx.$("#eks-x").addEventListener("click", () => ctx.$("#eks-setup").close());
ctx.$("#cluster-delete-cancel").addEventListener("click",
  () => ctx.$("#cluster-delete-dialog").close());
ctx.$("#cluster-delete-form").addEventListener("submit", clSubmitDelete);
ctx.$("#doctor-recheck").addEventListener("click", ctx.openDoctor);
ctx.$("#doctor-close").addEventListener("click", () => ctx.$("#doctor-dialog").close());
ctx.$("#cap-cancel").addEventListener("click", () => ctx.$("#cap-dialog").close());
ctx.$("#cap-submit").addEventListener("click", ctx.submitCap);

const POLL_MS = 4000;
let pollTimer = null;
function startPolling() { if (!pollTimer) pollTimer = setInterval(ctx.loadRepros, POLL_MS); }
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
// Each poll costs several docker CLI invocations; a hidden tab kept paying for them.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else { ctx.loadRepros(); startPolling(); }
});

ctx.loadRepros().then(ctx.restoreLocation);
ctx.adoptRunningJobs();
ctx.refreshKube();
startPolling();

Object.defineProperties(ctx, {
  "CLUSTERS": { enumerable: true, get: () => CLUSTERS, set: value => { CLUSTERS = value; } },
  "CLSTATE": { enumerable: true, get: () => CLSTATE },
  "clCost": { enumerable: true, get: () => clCost },
  "clAttention": { enumerable: true, get: () => clAttention },
  "refreshClusterBadge": { enumerable: true, get: () => refreshClusterBadge },
  "codeText": { enumerable: true, get: () => codeText },
  "awsSignIn": { enumerable: true, get: () => awsSignIn },
  "loadClusterOverview": { enumerable: true, get: () => loadClusterOverview },
  "clReadConnection": { enumerable: true, get: () => clReadConnection },
  "clStateOf": { enumerable: true, get: () => clStateOf },
  "clWhere": { enumerable: true, get: () => clWhere },
  "clRows": { enumerable: true, get: () => clRows },
  "clBuilding": { enumerable: true, get: () => clBuilding },
  "clForget": { enumerable: true, get: () => clForget },
  "clProbe": { enumerable: true, get: () => clProbe },
  "openClusters": { enumerable: true, get: () => openClusters },
  "clRefresh": { enumerable: true, get: () => clRefresh },
  "openPlace": { enumerable: true, get: () => openPlace },
  "openContext": { enumerable: true, get: () => openContext },
  "openEksSetup": { enumerable: true, get: () => openEksSetup },
  "clPrepare": { enumerable: true, get: () => clPrepare },
  "clCopy": { enumerable: true, get: () => clCopy },
  "clCopyDoc": { enumerable: true, get: () => clCopyDoc },
  "clOpenDns": { enumerable: true, get: () => clOpenDns },
  "renderClusterDeleteResult": { enumerable: true, get: () => renderClusterDeleteResult },
  "renderClusterCreateResult": { enumerable: true, get: () => renderClusterCreateResult },
  "renderClusterSweepResult": { enumerable: true, get: () => renderClusterSweepResult },
  "clAskDelete": { enumerable: true, get: () => clAskDelete },
  "clSubmitDelete": { enumerable: true, get: () => clSubmitDelete },
  "POLL_MS": { enumerable: true, get: () => POLL_MS },
  "pollTimer": { enumerable: true, get: () => pollTimer, set: value => { pollTimer = value; } },
  "startPolling": { enumerable: true, get: () => startPolling },
  "stopPolling": { enumerable: true, get: () => stopPolling },
});
export { CLUSTERS, CLSTATE, clCost, clAttention, refreshClusterBadge, codeText, awsSignIn, loadClusterOverview, clReadConnection, clStateOf, clWhere, clRows, clBuilding, clForget, clProbe, openClusters, clRefresh, openPlace, openContext, openEksSetup, clPrepare, clCopy, clCopyDoc, clOpenDns, renderClusterDeleteResult, renderClusterCreateResult, renderClusterSweepResult, clAskDelete, clSubmitDelete, POLL_MS, pollTimer, startPolling, stopPolling };
