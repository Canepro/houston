import { ctx } from "./shared.js";

// ---- clusters: where workspaces run, and what that is costing ----------------
// A peer of the edge, and the same two halves: a chip that is always visible so a
// forgotten cluster cannot stay forgotten, and a view with room for the detail.
// The chip alone was considered and is not enough -- the ledger has a cost
// breakdown, a per-cluster card and a twenty-second region sweep that needs
// somewhere to report progress, and none of that fits in a modal.
let CLUSTERS = null;          // the cheap list: what contexts exist
const CLSTATE = {             // per-context status, filled in as each probe returns
  status: {},                 // context -> the status document, or null while loading
  sweep: null,                // the last region sweep result
  deleting: "",               // which cluster the delete dialog is about
};

// A cluster is "billing" when its own ledger priced it. Read from the answer rather
// than from the name, because the answer is the thing that actually counted nodes.
const clCost = (st) => (st && st.cost && st.cost.usd_hr) || 0;

function clAttention(st) {
  // What makes a cluster want you, in the sense the colour rule means. NOT cost:
  // a cluster you are deliberately paying for is doing its job.
  if (!st) return "";
  // It wants you, but not for the reason an unreachable cluster does: nothing is
  // wrong and nothing is being paid for -- there is just an entry naming something
  // that is not there. `reach_why` here would be the down reason, which is true of
  // the connection and misleading about the cluster.
  if (st.gone) return "AWS says this cluster no longer exists — its kubeconfig entry "
                      + "is left over";
  if (!st.reachable) return st.reach_why || "it could not be read";
  if (st.expires_in_days !== undefined && st.expires_in_days !== null
      && st.expires_in_days < 0) return `expired ${-st.expires_in_days} day(s) ago`;
  if ((st.unreadable || []).length) return `${st.unreadable.join(", ")} could not be read`;
  return "";
}

async function refreshClusterBadge() {
  const badge = ctx.$("#cluster-badge");
  if (!badge) return;
  try { CLUSTERS = await ctx.api("/api/clusters"); }
  catch (_) { badge.hidden = true; return; }      // no gui extra / no permission
  const n = (CLUSTERS.contexts || []).length;
  if (!n) { badge.hidden = true; return; }        // nothing to be forgotten about
  badge.hidden = false;
  // The chip reports what is already KNOWN, and never starts a probe of its own:
  // it is drawn on every refresh and the ledger's probes are six round trips per
  // cluster. Cost and attention appear once the view has been opened, which is the
  // only place those numbers are read.
  const known = Object.values(CLSTATE.status).filter(Boolean);
  const perHr = known.reduce((t, st) => t + clCost(st), 0);
  const wants = known.filter((st) => clAttention(st)).length;
  const billable = (CLUSTERS.contexts || []).filter((c) => c.billable).length;
  let text = `clusters: ${n}`;
  if (perHr) text = `clusters: ~$${(perHr * 24).toFixed(2)}/day`;
  else if (billable) text = `clusters: ${n} · ${billable} managed`;
  if (wants) text += ` · ${wants} want${wants === 1 ? "s" : ""} you`;
  badge.textContent = text;
  badge.className = "chip" + (wants ? " warn" : " up");
}

// SERVICE MESSAGES ARE WRITTEN FOR A TERMINAL, where `like this` is the convention
// for a command. Rendered into HTML as text those backticks are just characters on
// screen, and they read as a rendering fault -- which is what they are. One helper,
// because the alternative is either a second set of messages written for the browser
// (which would drift from the ones the CLI prints) or backticks nobody meant.
function codeText(text) {
  const out = [];
  String(text ?? "").split("`").forEach((part, i) => {
    if (part === "") return;
    out.push(i % 2 ? ctx.el("code", {}, part) : part);
  });
  return out;
}

function clCell(label, value, unknown) {
  return ctx.el("div", { class: "cl-cell" },
    ctx.el("div", { class: "cl-k" }, label),
    ctx.el("div", { class: "cl-v" + (unknown ? " unknown" : "") }, unknown ? "?" : String(value)));
}

function renderClusterCard(row) {
  const st = CLSTATE.status[row.context];
  const card = ctx.el("div", { class: "cl-card" });
  const attn = clAttention(st);
  if (attn) card.classList.add("attn");

  // AWS ASSERTING THE CLUSTER IS NOT THERE reads nothing like a cluster that is down.
  // It costs nothing, nothing about it is unknown, and the only thing wanted is that
  // the leftover kubeconfig entry be cleared -- so it gets the muted pill, not the
  // one that means "something you are paying for is not answering".
  const gone = !!(st && st.gone);
  const pill = st
    ? (st.reachable ? ctx.el("span", { class: "pill running" }, "running")
       : gone ? ctx.el("span", { class: "pill unknown" }, "gone")
       : ctx.el("span", { class: "pill refusing" },
            st.reach_status === "denied" ? "refusing"
            : st.reach_status === "no-context" ? "no credentials here" : "not answering"))
    : ctx.el("span", { class: "pill down" }, "reading…");
  const kind = (st && st.distribution) || row.provider || "";
  const owned = row.ours ? "houston's own" : "yours";
  card.append(ctx.el("div", { class: "cl-h" }, pill,
    ctx.el("span", { class: "cl-name", title: row.context }, row.context),
    row.is_default ? ctx.el("span", { class: "chip", title: "`houston up --runtime "
                                        + "kubernetes` uses this one when no cluster "
                                        + "is named" },
                        "default for ", ctx.el("code", {}, "up")) : "",
    ctx.el("span", { class: "cl-sp" }),
    ctx.el("span", { class: "chip" }, `${kind || "unknown"} · ${owned}`)));

  const grid = ctx.el("div", { class: "cl-grid" });
  // `{}` IS TRUTHY. A cluster whose nodes carry no instance-type label -- kind, k3s,
  // anything not EC2 -- has `instance_types: {}`, which passed this test and rendered
  // the join of nothing: an empty Nodes cell on a cluster with a node in it. Seen on
  // screen beside an EKS card correctly reading "2× t3.large".
  const shapes = (st && st.instance_types) ? Object.entries(st.instance_types) : [];
  const nodes = shapes.length
    ? shapes.map(([t, c]) => `${c}× ${t || "unlabelled"}`).join(", ")
    : (st && st.nodes);
  grid.append(
    clCell("Nodes", nodes, !st || st.nodes === null),
    clCell("Up for", st && st.age_hours !== null && st.age_hours !== undefined
      ? `${Math.floor(st.age_hours / 24)}d ${Math.floor(st.age_hours % 24)}h` : "",
      !st || st.age_hours === null || st.age_hours === undefined),
    clCell("Workspaces", st && st.workspaces ? st.workspaces.length : 0,
      !st || st.workspaces === null),
    clCell("Volumes", st && st.pvcs, !st || st.pvcs === null),
    clCell("Load balancers", st && st.loadbalancers, !st || st.loadbalancers === null),
    // "unknown" only when it really is. A cluster AWS says does not exist costs
    // nothing, and dimming that cell would keep implying a bill that has stopped.
    clCell("Cost", gone ? "nothing" : (st && st.cost ? `~$${st.cost.usd_hr}/hr` : "free"),
      !gone && !!(st && !st.reachable)));
  card.append(grid);

  // WHY it could not be read, in the card, with the remedy. "is not answering" was
  // printed for a cluster that was up and merely refusing the credential, which sent
  // the reader to check the one thing that was fine.
  if (gone) {
    card.append(ctx.el("div", { class: "cl-foot" },
      ctx.el("p", { class: "banner" },
        ...codeText(st.reach_advice
          || "AWS says this cluster no longer exists, so it is not costing anything."))));
  } else if (st && !st.reachable) {
    card.append(ctx.el("div", { class: "cl-foot" },
      ctx.el("p", { class: "banner warn" },
        ...codeText(`${st.reach_why || "it could not be read"}.${st.reach_advice || ""} `),
        ctx.el("b", {}, "These are unknown, not zero."))));
  } else if (attn) {
    card.append(ctx.el("div", { class: "cl-foot" },
      ctx.el("p", { class: "banner warn" }, ...codeText(attn))));
  }
  // A CLUSTER HOUSTON MADE AND CAN NO LONGER TAKE AWAY. Uninstalling the kind binary
  // leaves it running, reachable and holding memory, while every control that would
  // remove it answers "there was nothing to delete". Without this the card looks like
  // an ordinary healthy cluster with no remove action, which is indistinguishable
  // from the GUI simply not offering one.
  if (st && st.manageable === false && st.unmanageable_why) {
    card.append(ctx.el("div", { class: "cl-foot" },
      ctx.el("p", { class: "banner warn" }, ...codeText(st.unmanageable_why))));
  }

  if (st && st.workspaces && st.workspaces.length) {
    card.append(ctx.el("div", { class: "cl-foot" },
      ctx.el("span", { class: "cl-note" },
        "holding " + st.workspaces.map((w) => w.name).join(", ")),
      ctx.el("span", { class: "cl-note" },
         " — what is in the cluster, which on a shared one includes workspaces made "
         + "from another machine. The list on the left is only this machine's.")));
  }

  const foot = ctx.el("div", { class: "cl-foot" });
  // A CONTROL THAT CANNOT SUCCEED IS WORSE THAN NO CONTROL — the same rule that keeps
  // the logs and env tabs off a readonly user's panel. On a cluster AWS says does not
  // exist, "Prepare" has nothing to prepare and "Delete cluster" has nothing to
  // delete; both could only ever produce a red toast. What is actually wanted is the
  // kubeconfig entry cleared, so that is the control offered instead.
  if (ctx.canWrite() && !gone) {
    foot.append(ctx.el("button", { class: "btn small", onclick: () => clPrepare(row.context) },
      "Prepare"));
  }
  foot.append(ctx.el("button", { class: "btn small",
    title: "The kubeconfig context name — paste it after `--context`",
    onclick: () => clCopy(row.context, "cluster name") }, "Copy name"));
  if (ctx.canWrite() && gone) {
    foot.append(ctx.el("button", {
      class: "btn small",
      title: "Remove this machine's kubeconfig entry. The cluster is already gone; "
             + "nothing in AWS is touched.",
      onclick: () => clForget(row) }, "Forget this entry"));
  }
  if (ctx.canAdmin() && row.billable && !gone) {
    foot.append(ctx.el("button", { class: "btn danger small",
      onclick: () => clAskDelete(row, st) }, "Delete cluster…"));
  }
  card.append(foot);
  return card;
}

async function clForget(row) {
  // NOT a destroy, so no confirmation dialog: the cluster is already gone and this
  // removes a name from a local file. Red is reserved for "about to destroy
  // something", and this destroys nothing.
  try {
    await ctx.api("/api/clusters/forget",
      { method: "POST", body: JSON.stringify({ context: row.context }) });
    ctx.toast(`forgot ${row.context} — the cluster itself was not touched`, "ok");
    openClusters();
  } catch (e) { ctx.toast(e.message); }
}

async function clProbe(row, host) {
  try {
    CLSTATE.status[row.context] = await ctx.api(
      `/api/clusters/status?context=${encodeURIComponent(row.context)}`);
  } catch (e) {
    // A probe that ERRORED is not a cluster that is empty. Recorded as unreadable so
    // the card shows `?` rather than a row of zeros.
    CLSTATE.status[row.context] = { context: row.context, reachable: false,
      reach_why: e.message, reach_advice: "", unreadable: ["cluster"],
      nodes: null, workspaces: null, pvcs: null, loadbalancers: null, cost: null };
  }
  if (ctx.VIEW === "clusters") {
    const fresh = renderClusterCard(row);
    if (host && host.parentNode) host.replaceWith(fresh);
  }
  refreshClusterBadge();
  clRenderTotals();
}

function clRenderTotals() {
  const box = ctx.$("#cl-totals");
  if (!box) return;
  const rows = (CLUSTERS && CLUSTERS.contexts) || [];
  const known = rows.map((r) => CLSTATE.status[r.context]).filter(Boolean);
  const perHr = known.reduce((t, st) => t + clCost(st), 0);
  const held = known.reduce((t, st) => t + ((st.workspaces || []).length), 0);
  const unread = known.filter((st) => !st.reachable).length;
  box.innerHTML = "";
  const cell = (k, v) => ctx.el("div", {}, ctx.el("dt", {}, k), ctx.el("dd", {}, v));
  box.append(cell("Clusters", String(rows.length)));
  box.append(cell("Costing money", String(known.filter((st) => clCost(st)).length)));
  box.append(cell("Per day", perHr ? `~$${(perHr * 24).toFixed(2)}` : "—"));
  box.append(cell("Workspaces held", unread ? `${held}+` : String(held)));
}

async function openClusters() {
  // THE ROLE BEFORE THE CARDS. Every control here is role-aware, and MY_ROLE is
  // filled in by the four-second poll rather than at load -- so opening this view in
  // the first seconds of a session drew an admin's cards with a readonly user's
  // buttons and left them that way, because nothing re-renders when the role lands.
  // Measured: the Delete control was present on one run and absent on the next, from
  // the same account, purely on timing.
  if (!ctx.MY_ROLE) {
    try {
      const me = await ctx.api("/api/session");
      ctx.ACCOUNTS = !!me.accounts; ctx.ME = me.user || ""; ctx.MY_ROLE = me.role || "";
    } catch (_) { /* signed out; api() has already redirected */ }
  }
  ctx.setView("clusters");
  // NOT `no-detail`, which Activity sets: that class hides the action pane outright,
  // and this view has one. The pane is where the two things that are about the whole
  // ledger rather than one cluster live -- building a new one, and the permissions
  // documents somebody with no shell still has to hand out.
  ctx.$(".panes").classList.remove("no-detail");
  const panel = ctx.$("#detail");
  panel.innerHTML = "";
  panel.append(ctx.el("div", { class: "home-head" }, ctx.el("h1", {}, "Clusters"),
    ctx.el("p", {}, "Where workspaces run. A cluster is not a workspace, so it never appears "
      + "in the grid — and on a managed one it costs money for as long as it exists, "
      + "whether or not anything is running in it.")));
  const body = ctx.el("div", { class: "home-body" });
  const totals = ctx.el("dl", { class: "cl-tot", id: "cl-totals" });
  const list = ctx.el("div", { id: "cl-list" });
  body.append(totals, list);
  panel.append(body);
  clActionPane();

  try { CLUSTERS = await ctx.api("/api/clusters"); }
  catch (e) { list.append(ctx.el("p", { class: "empty" }, e.message)); return; }
  const rows = CLUSTERS.contexts || [];
  if (!rows.length) {
    list.append(ctx.el("p", { class: "empty" },
      "No cluster on this box yet. `up --runtime kubernetes` creates a local one; "
      + "a managed cluster is built with `cluster create`."));
  }
  // A card each, drawn immediately and filled in as its own probe returns, so one
  // refusing cluster costs one slow card rather than a slow page.
  for (const row of rows) {
    const host = renderClusterCard(row);
    list.append(host);
    clProbe(row, host);
  }
  if ((CLUSTERS.unreadable || "")) {
    list.append(ctx.el("p", { class: "cl-warn" },
      `the kubeconfig could not be fully listed (${CLUSTERS.unreadable}) — there may be `
      + "clusters missing from this page"));
  }
  clRenderTotals();
  list.append(clSweepBox());
}

function clSweepBox() {
  const box = ctx.el("div", { class: "cl-sweep" });
  box.append(ctx.el("h3", {}, "Every region, not just the one you are looking at"));
  box.append(ctx.el("p", { class: "cl-note" },
    "A cluster in a region nobody is thinking about is invisible to everything else "
    + "here. This asks AWS directly, by the tag houston puts on what it builds."));
  const out = ctx.el("div", { id: "cl-sweep-out" });
  box.append(ctx.el("div", { class: "cl-foot" },
    ctx.el("button", { class: "btn small", onclick: () => clSweep() }, "Sweep all regions"),
    ctx.el("span", { class: "cl-note", id: "cl-sweep-note" },
      CLSTATE.sweep ? "" : "takes about twenty seconds")), out);
  if (CLSTATE.sweep) clRenderSweep(out);
  return box;
}

function clRenderSweep(out) {
  const s = CLSTATE.sweep;
  out.innerHTML = "";
  if (!s) return;
  for (const c of s.clusters || []) {
    out.append(ctx.el("p", { class: "cl-note" },
      `${c.region}  ${c.name}  ${c.status || "?"}`
      + (c.expires ? ` · expires ${c.expires}` : "")
      + (c.ours ? "" : " · not houston's")));
  }
  if (!(s.clusters || []).length && (s.regions || []).length) {
    out.append(ctx.el("p", { class: "cl-note" },
      `no houston clusters found in ${s.regions.length} region(s)`));
  }
  // SAID LAST AND SAID PLAINLY, as the CLI does: "nothing found" and "nothing found
  // in the fourteen regions I could read" are different reports.
  for (const bad of s.unreadable || []) {
    out.append(ctx.el("p", { class: "cl-warn" },
      `${bad.region} could NOT be read (${bad.why}) — this report does not cover it`));
  }
  if (s.fallback) {
    out.append(ctx.el("p", { class: "cl-note" },
      `swept a built-in region list because the account could not be asked which are `
      + `enabled (${s.fallback})`));
  }
}

async function clSweep() {
  const note = ctx.$("#cl-sweep-note");
  if (note) note.textContent = "sweeping…";
  try {
    const { job_id } = await ctx.api("/api/clusters/sweep",
      { method: "POST", body: JSON.stringify({}) });
    ctx.streamJob(job_id, "Sweeping every region", (res) => {
      CLSTATE.sweep = res;
      if (note) note.textContent = `${(res.regions || []).length} region(s) swept`;
      const out = ctx.$("#cl-sweep-out");
      if (out) clRenderSweep(out);
    });
  } catch (e) { ctx.toast(e.message); if (note) note.textContent = ""; }
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
        // Still coming. Re-running is the right next action.
        ctx.toast("the load balancer has no address yet — prepare again in a minute");
      } else if (res) {
        // Not coming. Nothing is waiting on an address, so re-running cannot help,
        // and telling somebody to try again would be advice that never works.
        ctx.toast("no load balancer is waiting for an address — this cluster has no "
              + "load-balancing ingress, so workspaces here reach you by port-forward");
      }
      openClusters();
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

function clActionPane() {
  const pane = ctx.$("#actpane");
  pane.innerHTML = "";
  if (ctx.canAdmin()) {
    pane.append(ctx.el("div", { class: "apgroup" }, "Add a cluster"));
    pane.append(ctx.el("p", { class: "apnote" },
      "About twenty minutes, and it starts charging from the first minute."));
    pane.append(ctx.el("div", { class: "apnext" },
      ctx.el("button", { class: "apn", onclick: () => clOpenCreate() },
        ctx.el("b", {}, "Build a managed cluster"))));
  } else {
    pane.append(ctx.el("div", { class: "apgroup" }, "Add a cluster"));
    pane.append(ctx.el("p", { class: "apnote" },
      "Building and destroying clusters is an admin action on this box."));
  }
  pane.append(ctx.el("div", { class: "apgroup" }, "Permissions"));
  pane.append(ctx.el("p", { class: "apnote" },
    "The documents that let a non-root AWS identity do this. IAM alone is not enough: "
    + "a cluster refuses a person until an EKS access entry exists for them."));
  const list = ctx.el("div", { class: "aplist" });
  for (const [key, label] of [["operator", "Copy operator policy"],
                              ["engineer", "Copy engineer policy"],
                              ["rbac", "Copy engineer RBAC"]]) {
    list.append(ctx.el("button", { type: "button", onclick: () => clCopyDoc(key) }, label));
  }
  pane.append(list);
}

function clOpenCreate() {
  const dlg = ctx.$("#cluster-create-dialog");
  const cost = ctx.$("#cluster-create-cost");
  // The number comes from the SAME table the ledger prices with, so the dialog and
  // the card cannot quote different money.
  cost.textContent = "A three-node cluster costs roughly $0.44/hr — about $10.50 a day — "
    + "until it is deleted. Nothing removes it on the expiry date.";
  ctx.$("#cluster-create-form").reset();
  dlg.showModal();
}

async function clSubmitCreate(ev) {
  ev.preventDefault();
  const f = new FormData(ctx.$("#cluster-create-form"));
  const body = {
    name: (f.get("name") || "").trim(),
    region: (f.get("region") || "").trim(),
    nodes: Number(f.get("nodes") || 0) || 0,
    expires: (f.get("expires") || "").trim(),
  };
  ctx.$("#cluster-create-dialog").close();
  try {
    const { job_id } = await ctx.api("/api/clusters/create",
      { method: "POST", body: JSON.stringify(body) });
    ctx.streamJob(job_id, `Building ${body.name} — about twenty minutes`, (res) => {
      ctx.toast(`cluster ${body.name} is up in ${(res && res.region) || ""}`, "ok");
      openClusters();
    });
  } catch (e) { ctx.toast(e.message); }
}

function clAskDelete(row, st) {
  const name = row.context.split("/").pop();
  CLSTATE.deleting = name;
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
      { method: "POST", body: JSON.stringify({ name, force }) });
    ctx.streamJob(job_id, `Deleting ${name}`, () => {
      ctx.toast(`cluster ${name} is gone`, "ok");
      delete CLSTATE.status[name];
      openClusters();
    });
  } catch (e) { ctx.toast(e.message); }
}

ctx.$("#edge-close").addEventListener("click", () => ctx.$("#edge-dialog").close());
// The note in section 2 follows BOTH things it talks about: which cluster, and
// whether a name has been given. Without the second listener it kept telling somebody
// to set a domain they had just set.
ctx.$("#context-select").addEventListener("change", ctx.syncClusterNote);
ctx.$("#create-form").domain.addEventListener("input", ctx.syncClusterNote);
ctx.$("#cluster-badge").addEventListener("click", () => openClusters());
ctx.$("#cluster-create-cancel").addEventListener("click",
  () => ctx.$("#cluster-create-dialog").close());
ctx.$("#cluster-create-form").addEventListener("submit", clSubmitCreate);
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
// Each poll costs several docker CLI invocations (info + compose ls + ps); a
// hidden tab kept paying for them forever, and every open tab multiplied it.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else { ctx.loadRepros(); startPolling(); }
});

ctx.loadRepros();
ctx.refreshKube();
startPolling();

Object.defineProperties(ctx, {
  "CLUSTERS": { enumerable: true, get: () => CLUSTERS, set: value => { CLUSTERS = value; } },
  "CLSTATE": { enumerable: true, get: () => CLSTATE },
  "clCost": { enumerable: true, get: () => clCost },
  "clAttention": { enumerable: true, get: () => clAttention },
  "refreshClusterBadge": { enumerable: true, get: () => refreshClusterBadge },
  "codeText": { enumerable: true, get: () => codeText },
  "clCell": { enumerable: true, get: () => clCell },
  "renderClusterCard": { enumerable: true, get: () => renderClusterCard },
  "clForget": { enumerable: true, get: () => clForget },
  "clProbe": { enumerable: true, get: () => clProbe },
  "clRenderTotals": { enumerable: true, get: () => clRenderTotals },
  "openClusters": { enumerable: true, get: () => openClusters },
  "clSweepBox": { enumerable: true, get: () => clSweepBox },
  "clRenderSweep": { enumerable: true, get: () => clRenderSweep },
  "clSweep": { enumerable: true, get: () => clSweep },
  "clPrepare": { enumerable: true, get: () => clPrepare },
  "clCopy": { enumerable: true, get: () => clCopy },
  "clCopyDoc": { enumerable: true, get: () => clCopyDoc },
  "clActionPane": { enumerable: true, get: () => clActionPane },
  "clOpenCreate": { enumerable: true, get: () => clOpenCreate },
  "clSubmitCreate": { enumerable: true, get: () => clSubmitCreate },
  "clAskDelete": { enumerable: true, get: () => clAskDelete },
  "clSubmitDelete": { enumerable: true, get: () => clSubmitDelete },
  "POLL_MS": { enumerable: true, get: () => POLL_MS },
  "pollTimer": { enumerable: true, get: () => pollTimer, set: value => { pollTimer = value; } },
  "startPolling": { enumerable: true, get: () => startPolling },
  "stopPolling": { enumerable: true, get: () => stopPolling },
});
export { CLUSTERS, CLSTATE, clCost, clAttention, refreshClusterBadge, codeText, clCell, renderClusterCard, clForget, clProbe, clRenderTotals, openClusters, clSweepBox, clRenderSweep, clSweep, clPrepare, clCopy, clCopyDoc, clActionPane, clOpenCreate, clSubmitCreate, clAskDelete, clSubmitDelete, POLL_MS, pollTimer, startPolling, stopPolling };
