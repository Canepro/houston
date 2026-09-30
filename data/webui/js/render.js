import { ctx } from "./shared.js";

// ---- triage: what is wrong, and what to do about it -------------------------
//
// The panel is opened when something LOOKS wrong, and it used to open with six
// facts that never change. The one thing on it that said anything was wrong -- the
// restart banner -- was under them, which on a 900px window is under the fold. This
// goes first, and it answers the two questions in the order they get asked: what is
// wrong, and what do I do about it.
//
// Every entry is a rule over what the payload already carries, never a guess about
// intent. Guessing "next" wrongly is worse than not guessing, so nothing here is
// inferred from a workspace's name, its age or its preset.
//
// The quiet state is ABSENCE. A healthy workspace gets no block at all rather than a
// green one saying so -- a box that is always on screen stops being read, and the six
// facts below it already say everything is fine.
function triageOf(d) {
  const out = [];
  const push = (title, why, actions) => out.push({ title, why, actions: actions.filter(Boolean) });
  // Logs are member+ on the server (they carry an LDAP bind password), so offering
  // the button to a readonly reader would offer them a 403.
  const logs = ctx.canWrite() && ["Open the logs", () => ctx.switchTab("logs"), true];
  const pods = ["See the pods", () => ctx.switchTab("containers")];

  // The STATE comes first and comes alone. The health of a workspace that is not
  // running is not a second problem, it is the same problem said twice.
  if (d.state === "?") {
    push("Docker is not answering",
         "Nothing here can report its state, start or stop until it is back.",
         [["Check this box", ctx.openDoctor, true]]);
    return out;
  }
  if (d.state === "down") {
    push("This workspace is not running",
         `Its record and its data volume are still here, and :${d.host_port} stays `
         + "reserved for it. Bringing it up reuses both.",
         [ctx.canWrite() && ["Bring it up", () => ctx.doBringUp(d.name), true]]);
    return out;
  }
  if (d.state === "stopped") {
    push("This workspace is stopped",
         d.runtime === "kubernetes"
           ? "Its release is scaled to zero. The data and the namespace are intact."
           : "Its containers exist and are not running. The data volume is intact.",
         [ctx.canWrite() && ["Start it", () => ctx.doState(d.name, "start"), true]]);
    return out;
  }

  // Restarting, or a restart count that is climbing. Two restarts is the line
  // because one is what a slow first boot looks like.
  const n = d.restarts || 0;
  // CLIMBING, or unhealthy right now -- not a total. A workspace that restarted twice
  // while booting and has served ever since is not restarting, and saying so in the
  // present tense is false. The count itself is still in the containers tab, which is
  // where a fact belongs when it is not asking for anything.
  const rcClimbing = ctx.restartsClimbing(d.name, "__rocketchat__", n);
  if (d.state === "restarting" || (n >= 2 && (rcClimbing || ctx.healthClass(d) === "bad"))) {
    // The free-memory sentence only when the number is actually known -- the home
    // stage fetches it, and inventing one would be worse than leaving it out.
    const free = ctx.HOME.cap && ctx.HOME.cap.known
      ? ` This box has ${ctx.fmtGb(Math.max(0, (ctx.HOME.cap.available_mb || 0)
                                          - (ctx.HOME.cap.reserve_mb || 0)))} free.` : "";
    push(n ? `Rocket.Chat has restarted ${n}×` : "Rocket.Chat is restarting",
         "That is usually memory pressure — the kernel kills it and Docker starts it "
         + "again — or an error during boot, which the logs name." + free,
         [logs, ["Check this box", ctx.openDoctor]]);
  } else if (ctx.healthClass(d) === "bad") {
    // Running, answering, and reporting itself unhealthy: its healthcheck is what
    // knows why, and the logs are where it says so.
    push("It is failing its healthcheck",
         "The container is up but Rocket.Chat is not answering the check it sets "
         + "for itself, so anything talking to it will see errors.",
         [logs]);
  }

  // A pod OTHER than Rocket.Chat's that keeps restarting. The rule above counts
  // Rocket.Chat's own restarts and nothing counted the rest, so on microservices a
  // ddp-streamer or presence pod could crash-loop all day with the panel calling the
  // workspace healthy -- and it is the same fault, one layer along. `app` is the
  // server's answer to "which pod is Rocket.Chat", from the label it selects on.
  const flapping = (d.containers || []).filter((c) => {
    if (c.app) return false;
    const count = c.restarts || 0;
    const climbing = ctx.restartsClimbing(d.name, c.service, count);
    // `health` is the server's answer to "is every container in this pod ready",
    // decided next to the list that defines it. A pod that is ready now is not
    // crash-looping now, whatever its history.
    return count >= 2 && (climbing || c.health !== "healthy");
  });
  if (flapping.length) {
    const one = flapping.length === 1;
    push(one ? `${flapping[0].service} keeps restarting`
             : `${flapping.length} pods keep restarting`,
         (one ? `It has restarted ${flapping[0].restarts}×`
              : flapping.slice(0, 3).map((c) => `${c.service} — ${c.restarts}×`).join(" · "))
         + ". Rocket.Chat depends on these, so it will be failing in ways its own logs "
         + "only half explain.",
         [pods]);
  }

  // Pods that cannot start, named. `blocked` is decided server-side by the module
  // that owns the list of reasons a pod never recovers from (src/core/kube/status.ts); the
  // browser reads the flag rather than keeping a second copy of the policy, which is
  // how the create dialog's refusal list came to be wrong.
  const stuck = (d.containers || []).filter((c) => c.blocked);
  if (stuck.length) {
    push(stuck.length === 1 ? "One pod cannot start"
                            : `${stuck.length} pods cannot start`,
         stuck.slice(0, 3).map((c) => `${c.service} — ${c.status}`).join(" · ")
         + ". Kubernetes will keep retrying and will not get further on its own.",
         [pods]);
  }

  // The https name resolves and answers 502, which looks like a broken workspace
  // rather than a broken route -- so it has to be said next to the workspace.
  const route = ((ctx.EDGE && ctx.EDGE.routes) || []).find((r) => r.name === d.name);
  if (route && route.reachable === false) {
    push("The edge cannot reach this workspace",
         `${d.public_url || "Its https name"} answers 502. The route exists; the `
         + "edge is not on this workspace's network.",
         [["Look at the edge", ctx.openEdge, true]]);
  }
  return out;
}

function triageBlock(d) {
  const items = triageOf(d);
  if (!items.length) return null;
  // Amber, not red. The rule in app.css is that red means "about to destroy
  // something" -- a crash-looping workspace wants you, it does not threaten you, and
  // spending red here leaves nothing louder for the Down button.
  const box = ctx.el("div", { class: "triage" });
  for (const t of items) {
    const card = ctx.el("div", { class: "tri" });
    card.append(ctx.el("span", { class: "tri-i" }, "▲"));
    card.append(ctx.el("div", { class: "tri-t" },
      ctx.el("b", {}, t.title), ctx.el("span", {}, t.why)));
    if (t.actions.length) {
      const row = ctx.el("div", { class: "tri-a" });
      for (const [label, fn, primary] of t.actions) {
        row.append(ctx.el("button", { class: "btn small" + (primary ? " solid" : ""),
                                  onclick: fn }, label));
      }
      card.append(row);
    }
    box.append(card);
  }
  return box;
}

function renderDetail() {
  const d = ctx.dstate.detail; if (!d) return;
  if (ctx.dstate.statsTimer) { clearInterval(ctx.dstate.statsTimer); ctx.dstate.statsTimer = null; }
  const panel = ctx.$("#detail"); panel.innerHTML = "";
  const busyLabel = ctx.pendingOn(d.name);
  // Same builder as the cards: `dBtn` disables every action while one is in
  // flight and animates the one doing the work.
  const dBtn = (label, fn, cls = "", title = "") =>
    ctx.actionButton(label, fn, { cls, title, pending: busyLabel });
  const head = ctx.el("div", { class: "d-head" },
    ctx.el("span", { class: "dot " + ctx.stateClass(d.state) }, "●"),
    ctx.el("span", { class: "name" }, d.name),
    busyLabel
      ? ctx.el("span", { class: "pill working" }, (ctx.BUSY_VERB[busyLabel] || busyLabel).toLowerCase() + "…")
      : ctx.el("span", { class: "pill " + ctx.stateClass(d.state) }, d.state),
    ctx.el("button", { class: "close", onclick: ctx.closeDetail }, "×"));
  const sub = ctx.el("div", { class: "d-sub" },
    ctx.el("b", {}, d.rc_version || "?"), ctx.el("i", {}, "/"), `mongo ${d.mongo_tag || "?"}`);
  if (d.preset) sub.append(ctx.el("i", {}, "·"), d.preset);
  sub.append(ctx.el("i", {}, "·"), ":" + d.host_port);
  if (d.created_by) {
    sub.append(ctx.el("i", {}, "·"), d.created_by + (d.created_by === ctx.ME ? " (you)" : ""));
  }
  if (d.public_url) {
    const route = (ctx.EDGE && ctx.EDGE.routes || []).find((r) => r.name === d.name);
    sub.append(ctx.el("i", {}, "·"),
      ctx.el("span", { class: route && route.reachable === false ? "bad" : "" },
        route && route.reachable === false
          ? "https — unreachable, answers 502"
          : (ctx.TLS_LABEL[d.tls] || "https")));
  }
  const tabs = ctx.el("div", { class: "tabs" });
  for (const t of ["overview", "logs", "containers", "env vars", "backups"]) {
    const key = t === "env vars" ? "env" : t;
    // Logs and env are member+ on the server: both hand over real credentials.
    // Rendering a tab that can only answer 403 is worse than not rendering it.
    if (!ctx.canWrite() && (key === "logs" || key === "env")) continue;
    tabs.append(ctx.el("button", { class: "tab" + (ctx.dstate.tab === key ? " active" : ""), onclick: () => ctx.switchTab(key) },
      t.charAt(0).toUpperCase() + t.slice(1)));
  }
  if (!ctx.canWrite() && (ctx.dstate.tab === "logs" || ctx.dstate.tab === "env")) ctx.dstate.tab = "overview";
  const actions = ctx.el("div", { class: "d-actions" });
  if (d.state !== "?") {
    actions.append(ctx.el("a", { href: d.root_url, target: "_blank", style: "text-decoration:none" },
      ctx.el("button", { class: "btn primary" }, "↗ Open RC")));
  }
  if (!ctx.canWrite()) {
    actions.append(ctx.el("span", { class: "inline-note", title: ctx.READONLY_WHY },
      "readonly — you can look, but not change anything here"));
  } else if (d.state === "running") {
    actions.append(dBtn("Stop", () => ctx.doState(d.name, "stop")));
    actions.append(dBtn("Restart", () => ctx.doState(d.name, "restart")));
  } else if (d.state === "stopped") {
    actions.append(dBtn("Start", () => ctx.doState(d.name, "start")));
  } else if (d.state === "down") {
    actions.append(dBtn("Bring up", () => ctx.doBringUp(d.name), "primary"));
  } else if (d.state === "?") {
    actions.append(ctx.el("span", { class: "inline-note" }, "docker unavailable — actions disabled"));
  } else {
    // restarting / created / paused / dead
    actions.append(dBtn("Stop", () => ctx.doState(d.name, "stop")));
    actions.append(dBtn("Restart", () => ctx.doState(d.name, "restart")));
  }
  // Rendered always and shown only by the narrow layout, where the action pane is not
  // a column. It scrolls the pane into view as well as revealing it: the pane follows
  // the stage in the document, so revealing it silently would put it below a panel
  // that can be several screens tall.
  if (ctx.canWrite()) {
    actions.append(ctx.el("button", { class: "btn small panetoggle", onclick: () => {
      const open = !document.body.classList.contains("pane-open");
      document.body.classList.toggle("pane-open", open);
      if (open) ctx.$("#actpane").scrollIntoView({ block: "start", behavior: "smooth" });
    } }, "Actions ⌄"));
  }
  ctx.renderActionPane(d, busyLabel);
  // Above the TABS, not inside Overview: what is wrong with the workspace is not a
  // property of the tab you happen to be on, and it was invisible from Logs --
  // which is precisely where you go when something is wrong.
  panel.append(head, sub);
  const tri = triageBlock(d);
  if (tri) panel.append(tri);
  panel.append(tabs, actions, ctx.el("div", { class: "d-body", id: "d-body" }));
  renderTab();
}

function closeLogs() { if (ctx.dstate.logsWS) { try { ctx.dstate.logsWS.close(); } catch (_) {} ctx.dstate.logsWS = null; } }
function copy(text) { navigator.clipboard.writeText(text); ctx.toast("copied", "ok"); }
// A urlbox row whose value is plain text rather than a link, with a copy button.
const box2 = (label, shown, toCopy) => ctx.el("div", { class: "urlbox" },
  ctx.el("div", {}, ctx.el("div", { class: "k" }, label), ctx.el("div", { class: "flat" }, shown)),
  ctx.el("button", { class: "copy", onclick: () => copy(toCopy) }, "copy"));
function renderTab() {
  const d = ctx.dstate.detail, body = ctx.$("#d-body"); if (!body) return;
  closeLogs();
  body.innerHTML = "";
  if (ctx.dstate.tab === "overview") {
    const kv = (k, v, cls = "") => ctx.el("div", { class: "kv" }, ctx.el("div", { class: "k" }, k), ctx.el("div", { class: "v " + cls }, v));
    // Exactly six, three columns, two full rows, no hole -- a seventh cell leaves an
    // empty third, which is why the conditional restart count below adds a ROW rather
    // than sitting between two of these.
    //
    // Rows were tried here and reverted: they read as a form rather than as a set of
    // readings, and the values lost the size that makes health and uptime findable
    // without looking for them. The facts a cell had nowhere to put -- "failing its
    // healthcheck", "restarted 4x" -- are said by the triage block above instead,
    // which is where a reader is looking when either of them is true.
    //
    // WHERE IT RUNS earns a cell. It decides what every other command will do to this
    // workspace -- which ones refuse, where the data lives, how to reach it -- and the
    // panel stated it nowhere. `Port` gave up its place: it is already in the identity
    // line under the title AND in the URL box below, so it was the one fact on this
    // grid stated three times, while the runtime was stated nowhere.
    const where = d.runtime === "kubernetes" ? "Kubernetes" : "Compose";
    const grid = ctx.el("div", { class: "kv-grid" },
      kv("RC Version", d.rc_version), kv("MongoDB", d.mongo_tag),
      kv("Runs on", d.deployment ? `${where} · ${d.deployment}` : where),
      kv("Uptime", d.uptime || "—", d.uptime ? "green" : ""),
      kv("Scenario", d.preset || "default"),
      // healthClass() knows unhealthy/starting/healthy; the kv only understood the
      // literal string "healthy", so a container reporting "running" rendered plain.
      kv("Health", d.health || d.state || "—", ctx.HEALTH_TONE[ctx.healthClass(d)] || ""));
    // A climbing restart count separates "slow to boot" from "crash-looping". No
    // banner under it any more: that is the triage block, above the tabs.
    if (typeof d.restarts === "number" && d.restarts > 0) {
      grid.append(kv("RC restarts", String(d.restarts), d.restarts >= 2 ? "bad" : "warn"));
    }
    body.append(grid);
    // Parsed once and shared: the links card merges a note that names a place it
    // already lists, and records which notes it took, so no group below repeats one.
    const parsed = ctx.noteItemsByGroup(d);
    const shown = new Set();
    const ownNotes = parsed.find((x) => x.g.kind === "scenario");
    if ((d.links && d.links.length) || (ownNotes && ownNotes.items.length)) {
      body.append(ctx.scenarioCard(d, parsed, shown));
    }
    // Everything else the workspace has to say, one card per group. A workspace made
    // before groups existed has none of these and its whole story stays in the card
    // above, unchanged.
    for (const { g, items } of parsed) {
      if (g.kind === "scenario") continue;          // rendered by the card above
      const card = ctx.noteGroupCard(g, items, shown);
      if (card) body.append(card);
    }
    if (d.state === "running") {
      const card = ctx.el("div", { class: "panelcard" },
        ctx.el("div", { class: "panelcard-h" },
          ctx.el("span", { class: "section-label flat" }, "Resource usage (live)"),
          // No legend: each panel holds one series and its own title names it.
          // A legend here would only restate the two labels already on the chart.
          ctx.el("span", { class: "chart-note" }, `every ${ctx.STATS_INTERVAL_S}s`)),
        ctx.el("div", { class: "chart-box" }, ctx.el("div", { id: "chart" })));
      body.append(card);
      ctx.startStats();
    }
    const url = ctx.el("div", { class: "urlbox" },
      ctx.el("div", {}, ctx.el("div", { class: "k" }, "URL"),
        ctx.el("a", { href: d.root_url, target: "_blank" }, d.root_url)),
      ctx.el("button", { class: "copy", onclick: () => copy(d.root_url) }, "copy"));
    body.append(url);
    // ADDITIVE, and deliberately so. The URL above is Rocket.Chat's own ROOT_URL and
    // stays exactly as it is -- houston's login, PAT, seeding and load-test calls
    // all go through it, and RC advertises it to browsers for links, OAuth callbacks
    // and CORS. Rewriting it for the convenience of a remote reader would change
    // what the server tells every client about itself. So this is a NOTICE: it says
    // what the address means from where you are standing, and changes nothing.
    const remote = ctx.remoteHost();
    if (remote) {
      const wide = ctx.WIDE_BINDS.includes(String(d.bind_host || ""));
      const port = d.host_port;
      if (wide) {
        body.append(ctx.el("p", { class: "banner" },
          `You are reading this from ${remote}, and “localhost” above means `
          + `YOUR machine. This workspace publishes on every interface, so from here `
          + `it is at:`));
        body.append(box2("From this machine", `http://${remote}:${port}`,
                         `http://${remote}:${port}`));
      } else {
        body.append(ctx.el("p", { class: "banner warn" },
          `You are reading this from ${remote}, and “localhost” above means YOUR `
          + `machine — not the server. This workspace publishes on `
          + `${d.bind_host || "127.0.0.1"}, so only the server itself can reach it. `
          + `To reach a workspace from here, create it with Bind host 0.0.0.0 under `
          + `Advanced options — or have an admin run `
          + `\`houston config set bind_host 0.0.0.0\` once for the whole box. `
          + `Workspaces ship a fixed admin/admin123, so do that only on a network `
          + `you trust.`));
      }
    }
    // The admin login was only ever shown in the create dialog's result box, so
    // once that was closed nothing in the GUI could tell you the password again --
    // even though it has always been in this very payload. (It is a fixed local
    // sandbox credential, not a secret; the CLI prints it on up/ready/info.)
    if (d.login) {
      body.append(box2("Admin login", `${d.login.user} / ${d.login.password}`, d.login.password));
    }
    // The env tab masks credentials and points the reader at the compose file on
    // disk; this is where that file lives.
    if (d.workspace) body.append(box2("Workspace", d.workspace, d.workspace));
  } else if (ctx.dstate.tab === "logs") {
    ctx.renderLogs(body, d);
  } else if (ctx.dstate.tab === "containers") {
    const kube = d.runtime === "kubernetes";
    const t = ctx.el("table", { class: "dtable" },
      ctx.el("tr", {}, ctx.el("th", {}, kube ? "pod" : "service"), ctx.el("th", {}, "state"), ctx.el("th", {}, "status")));
    for (const c of (d.containers || [])) t.append(ctx.el("tr", {}, ctx.el("td", {}, c.service), ctx.el("td", {}, c.state), ctx.el("td", { class: "v" }, c.status || c.health || "")));
    body.append(t);
    if (!(d.containers || []).length) {
      // "No containers — this repro is down." was printed under RUNNING Kubernetes
      // workspaces, because the payload's empty list was the only thing this read
      // and on that runtime it was always empty. It carries pods now, so an empty
      // list here means what it says again — but only ever about the right runtime.
      body.append(ctx.el("p", { class: "empty" },
        d.state === "?" ? "Docker is unavailable."
          : kube ? `No pods in houston-${d.name} — this workspace is ${d.state}.`
          : "No containers — this repro is down."));
    }
    if (kube) {
      body.append(ctx.el("p", { class: "hint" },
        "Pods, not containers: on Kubernetes this is every pod in the workspace's "
        + "namespace — Rocket.Chat, MongoDB and any scenario service. A pod that "
        + "cannot start says why here (ImagePullBackOff, CrashLoopBackOff)."));
    }
  } else if (ctx.dstate.tab === "env") {
    ctx.renderEnv(body, d);
  } else if (ctx.dstate.tab === "backups") {
    ctx.renderBackups(body, d);
  }
}


Object.defineProperties(ctx, {
  "triageOf": { enumerable: true, get: () => triageOf },
  "triageBlock": { enumerable: true, get: () => triageBlock },
  "renderDetail": { enumerable: true, get: () => renderDetail },
  "closeLogs": { enumerable: true, get: () => closeLogs },
  "copy": { enumerable: true, get: () => copy },
  "box2": { enumerable: true, get: () => box2 },
  "renderTab": { enumerable: true, get: () => renderTab },
});
export { triageOf, triageBlock, renderDetail, closeLogs, copy, box2, renderTab };
