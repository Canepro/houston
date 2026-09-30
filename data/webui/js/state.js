import { ctx } from "./shared.js";

// ---- home ------------------------------------------------------------------
// What the stage shows when nothing is selected. It used to say "Select a
// workspace", which answers a question nobody asked.
//
// It leads with CAPACITY because that is what actually limits this tool: `up`
// refuses without headroom, and seven concurrent stacks once OOM-killed a 10 GB
// host with every individual create having succeeded. "Room for about 2 more" is
// the sentence that decides what you do next; a row of totals would look like a
// dashboard and say nothing.
let HOME = { cap: null, audit: [], at: 0 };
const HOME_EVERY = 15000;

async function refreshHome(force) {
  if (!force && Date.now() - HOME.at < HOME_EVERY) return;
  HOME.at = Date.now();
  const [cap, audit] = await Promise.all([
    ctx.api("/api/machine").catch(() => null),
    ctx.api("/api/audit?limit=6").catch(() => ({ lines: [] })),
  ]);
  if (cap) HOME.cap = cap;
  HOME.audit = (audit && audit.lines) || [];
  // `!SELECTED` is not the same question as "is Home on screen". Activity and
  // Scenarios are stage views with no workspace selected, so this timer repainted
  // the stage with Home underneath whatever you were reading -- the page appearing
  // to navigate itself, seconds after you opened it. render() has always asked the
  // right question (VIEW === "home"); this never got the same fix.
  if (ctx.VIEW === "home" && !ctx.SELECTED) renderHome();
}

// One running workspace, on Home. Two destinations live in this row and they are
// genuinely different places: the row opens the WORKSPACE (this tool's page about
// it), and Open goes to Rocket.Chat itself. A row that only did the first made
// getting to the actual chat server a two-step, which is the one thing everybody
// is here for.
//
// The status tile is not decoration in a list where everything is running: the
// dot is the HEALTH, so a container that is up but failing its healthcheck is
// amber here rather than looking identical to a good one.
function runningRow(r) {
  const health = String(r.health || "").toLowerCase();
  const bad = health && !["healthy", "running", "starting"].includes(health);
  const row = ctx.el("div", { class: "wsrow" });
  row.append(ctx.el("button", {
    class: "wsrow-main", onclick: () => selectRepro(r.name),
    title: `Open ${r.name} in houston`,
  },
    ctx.el("span", { class: "wsrow-tile" + (bad ? " bad" : "") }),
    ctx.el("span", { class: "wsrow-t" },
      ctx.el("b", {}, r.name),
      ctx.el("span", { class: "wsrow-m" },
        `${r.rc_version} · ${r.preset || "default"} · :${r.host_port}`))));
  const right = ctx.el("div", { class: "wsrow-r" });
  if (r.uptime) {
    right.append(ctx.el("span", { class: "wsrow-up" + (bad ? " bad" : "") },
      r.uptime, ctx.el("i", {}, bad ? health : "uptime")));
  }
  right.append(ctx.el("a", { class: "btn small", href: r.public_url || r.root_url,
                         target: "_blank", rel: "noreferrer",
                         title: "Open Rocket.Chat itself, in a new tab" }, "Open"));
  row.append(right);
  return row;
}

function capacityCard(cap) {
  const box = ctx.el("div", { class: "capcard" });
  if (!cap || !cap.known) {
    box.append(ctx.el("div", { class: "caphead" }, ctx.el("span", { class: "lbl" }, "Memory on this machine")),
      ctx.el("p", { class: "apnote", style: "padding:0" },
        "houston reads /proc/meminfo, which this machine does not have — so it "
        + "cannot say how much room is left, and `up` will not refuse on memory here."));
    return box;
  }
  const usedMb = Math.max(0, cap.total_mb - cap.available_mb);
  const pct = (n) => Math.max(0, Math.min(100, (n / cap.total_mb) * 100));
  const gb = (mb) => (mb / 1024).toFixed(1);
  const head = ctx.el("div", { class: "caphead" },
    ctx.el("span", { class: "lbl" }, "Memory on this machine"));
  // Speak up only when the answer is nearly no. "room for about 6 more" is a
  // number you read past; the bar below already shows how full the machine is,
  // and this line exists to catch the moment it stops being fine.
  if (cap.room <= 1) {
    head.append(ctx.el("span", { class: "caproom" + (cap.room < 1 ? " tight" : "") },
      cap.room >= 1 ? `room for about ${cap.room} more` : "not enough for another workspace"));
  }
  box.append(head);
  box.append(ctx.el("div", { class: "capnum" }, `${gb(usedMb)} GB`,
    ctx.el("small", {}, ` of ${gb(cap.total_mb)} GB in use`)));
  box.append(ctx.el("div", { class: "capbar" },
    ctx.el("i", { class: "used", style: `width:${pct(usedMb)}%` }),
    ctx.el("i", { class: "reserved", style: `width:${pct(cap.reserve_mb)}%`,
              title: "kept back for the machine itself" })));
  box.append(ctx.el("div", { class: "caplegend" },
    ctx.el("span", {}, ctx.el("i", { class: "k used" }), `in use ${gb(usedMb)} GB`),
    ctx.el("span", {}, ctx.el("i", { class: "k reserved" }), `held back ${gb(cap.reserve_mb)} GB`),
    ctx.el("span", {}, ctx.el("i", { class: "k free" }),
      `free ${gb(Math.max(0, cap.available_mb - cap.reserve_mb))} GB`)));
  return box;
}

function attentionItems() {
  const out = [];
  if (!ctx.DOCKER_OK) {
    out.push(["Docker is not answering",
      "Nothing can start, stop or report state until it is back.", ctx.openDoctor, "Check"]);
  }
  const broken = ((ctx.EDGE && ctx.EDGE.routes) || []).filter((r) => !r.reachable);
  for (const r of broken) {
    out.push([`The edge cannot reach ${r.name}`,
      "Its https name answers 502 rather than erroring, so it looks like a broken "
      + "workspace instead of a broken route.", ctx.openEdge, "Look"]);
  }
  for (const r of ctx.ALL_REPROS.filter((x) => x.state === "down")) {
    out.push([`${r.name} is down`,
      `It still holds port :${r.host_port} and its data volume.`,
      () => selectRepro(r.name), "Review"]);
  }
  return out;
}

function renderHome() {
  const panel = ctx.$("#detail");
  panel.innerHTML = "";
  const running = ctx.ALL_REPROS.filter((r) => r.state === "running");
  const hour = new Date().getHours();
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const head = ctx.el("div", { class: "home-head" },
    ctx.el("h1", {}, ctx.ME ? `Good ${part}, ${ctx.ME}` : "Your workspaces"),
    ctx.el("p", {}, `${ctx.ALL_REPROS.length} workspace(s) · ${running.length} running`
      + (ctx.DOCKER_OK ? "" : " · docker is not answering")));
  const body = ctx.el("div", { class: "home-body" });
  const items = attentionItems();
  if (items.length) {
    const card = ctx.el("div", { class: "hcard" },
      ctx.el("div", { class: "hcard-h" }, ctx.el("span", { class: "lbl" }, "Needs you"),
        ctx.el("span", { class: "lbl" }, String(items.length))));
    for (const [title, why, fn, label] of items) {
      card.append(ctx.el("div", { class: "att" },
        ctx.el("span", { class: "att-i" }, "▲"),
        ctx.el("span", { class: "att-t" }, ctx.el("b", {}, title), " — " + why),
        ctx.el("button", { class: "btn small", onclick: fn }, label)));
    }
    body.append(card);
  }

  const rcard = ctx.el("div", { class: "hcard" },
    ctx.el("div", { class: "hcard-h" }, ctx.el("span", { class: "lbl" }, "Running now"),
      ctx.el("span", { class: "lbl-n" }, `${running.length} of ${ctx.ALL_REPROS.length}`)));
  if (running.length) {
    const grid = ctx.el("div", { class: "mini" });
    for (const r of running) grid.append(runningRow(r));
    rcard.append(grid);
  } else {
    rcard.append(ctx.el("p", { class: "empty" }, ctx.canWrite()
      ? "Nothing is running. Start one from the list, or create a workspace."
      : "Nothing is running."));
  }
  body.append(rcard);
  body.append(capacityCard(HOME.cap));

  const acard = ctx.el("div", { class: "hcard" },
    ctx.el("div", { class: "hcard-h" }, ctx.el("span", { class: "lbl" }, "Recent activity"),
      ctx.el("button", { class: "btn small", onclick: () => ctx.openJobs("history") }, "All activity")));
  if (HOME.audit.length) {
    for (const a of HOME.audit) {
      acard.append(ctx.el("div", { class: "arow", "data-denied": String(a.outcome === "denied") },
        ctx.el("span", { class: "who" }, a.actor || "—"),
        ctx.el("span", { class: "kind" }, a.kind),
        ctx.el("span", { class: "what" }, a.label || ""),
        ctx.el("span", { class: "when" }, (a.ts || "").replace("T", " ").slice(5, 16))));
    }
  } else {
    acard.append(ctx.el("p", { class: "empty" }, "Nothing recorded yet."));
  }
  body.append(acard);
  panel.append(head, body);
}


// ---- scenarios --------------------------------------------------------------
// Where a preset's notes finally live. They were printed by `up` and `info` and
// shown nowhere in the browser -- which for `oidc` means a GUI-only user could
// not discover that the scenario does not work at all until an /etc/hosts line
// exists. The notes are pre-wrapped for an 80-column terminal, so they are set
// in a <pre> and allowed to scroll rather than re-flowed into a narrow column.
async function openScenarios() {
  ctx.setView("scenarios");
  ctx.$(".panes").classList.add("no-detail");
  ctx.$("#actpane").innerHTML = "";
  const panel = ctx.$("#detail");
  panel.innerHTML = "";
  const head = ctx.el("div", { class: "home-head" }, ctx.el("h1", {}, "Scenarios"),
    ctx.el("p", {}, "What each one adds to a plain Rocket.Chat, and what you have to do to use it."));
  const body = ctx.el("div", { class: "home-body" });
  body.append(ctx.el("p", { class: "empty" }, "loading…"));
  panel.append(head, body);
  let list;
  try { list = (await ctx.api("/api/presets")).presets || []; }
  catch (e) { body.innerHTML = ""; body.append(ctx.el("p", { class: "empty" }, e.message)); return; }
  if (ctx.VIEW !== "scenarios") return;                 // a newer view won the race
  body.innerHTML = "";
  for (const s of list) {
    const card = ctx.el("div", { class: "hcard scen" });
    const h = ctx.el("div", { class: "hcard-h" }, ctx.el("b", {}, s.name));
    if (s.requires_license) h.append(ctx.el("span", { class: "pill small" }, "needs a licence"));
    card.append(h);
    const inner = ctx.el("div", { class: "scen-b" });
    if (s.description) inner.append(ctx.el("p", { class: "scen-d" }, s.description));
    if (s.notes && s.notes.length) {
      inner.append(ctx.el("div", { class: "section-label" }, "Using this scenario"));
      inner.append(ctx.noteBlock(s.notes));
    }
    card.append(inner);
    const foot = ctx.el("div", { class: "scen-f" },
      ctx.el("span", {}, s.ports && s.ports.length
        ? "Extra ports: " + s.ports.join(", ") : "No extra ports"));
    if (ctx.canWrite()) {
      foot.append(ctx.el("button", { class: "btn small", onclick: () => ctx.openCreate(s.name) },
        "Create a workspace with this"));
    }
    card.append(foot);
    body.append(card);
  }
}


// One grouped note, as a card. Three kinds of content and each gets the treatment
// it needs rather than all three arriving as bullets:
//
//   rows      facts. A key/value table -- "Cluster: kind-x" was three facts welded
//             into a sentence, and a sentence is the wrong shape for a lookup.
//   body      what a reader needs to KNOW. Still read through the notes pattern's
//             three shapes, so a place line is still a link row and an indented
//             line is still a copyable box.
//   commands  what a reader has to PASTE. Its own block with a Copy button, never
//             prose -- these were buried mid-paragraph.
function noteGroupCard(g, items, shown) {
  const rows = g.rows || [], cmds = g.commands || [];
  // A place this workspace's link table ALREADY lists is not a second place: the
  // monitoring notes name Grafana and Prometheus, and both are link rows, so without
  // this the same two urls appear once as rows and again as prose one card below.
  const body = (items || []).filter((i) => !(shown && shown.has(i)));
  if (!rows.length && !body.length && !cmds.length) return null;
  const card = ctx.el("div", { class: "panelcard" });
  if (g.title) {
    card.append(ctx.el("div", { class: "panelcard-h" },
      ctx.el("span", { class: "section-label flat" }, g.title)));
  }
  if (rows.length) {
    const t = ctx.el("table", { class: "notetable" });
    for (const [k, v] of rows) {
      t.append(ctx.el("tr", {}, ctx.el("th", {}, k), ctx.el("td", {}, String(v))));
    }
    card.append(t);
  }
  if (body.length || cmds.length) {
    const box = ctx.el("div", { class: "panelcard-b notes" });
    // The body went through the SAME parser the ungrouped notes use, so the three
    // shapes hold inside a group and nothing about that pattern is re-decided here.
    if (body.length) ctx.renderNoteItems(box, body);
    for (const c of cmds) {
      box.append(ctx.el("div", { class: "note-cmd" },
        ctx.el("code", {}, c),
        ctx.el("button", { class: "cp", onclick: () => ctx.copy(c) }, "Copy")));
    }
    card.append(box);
  }
  return card;
}

// Every note this workspace has, parsed once, group by group. Parsed HERE rather
// than inside each card because the link rows are enriched from these: a note naming
// a place the links already list is the rest of what is known about that one row, not
// a second row -- and the notes it can come from are no longer all in one group.
function noteItemsByGroup(d) {
  const groups = d.note_groups || [];
  // A workspace whose record has no groups keeps its whole story in the scenario
  // card, exactly as before groups existed.
  if (!groups.length) {
    return [{ g: { kind: "scenario" }, items: ctx.parseNotes(d.notes || []) }];
  }
  return groups.map((g) => ({ g, items: ctx.parseNotes(g.body || []) }));
}



// The Scenario card: what this workspace adds beyond a plain Rocket.Chat, where
// those things are, and what you have to do to use them — in one block instead of
// a "Where things are" list and a "Using this scenario" list that never referred
// to each other.
function scenarioCard(d, parsed, shown) {
  const card = ctx.el("div", { class: "panelcard" });
  // Title it by what is actually IN it. A plain workspace with monitoring
  // attached has links and notes but no scenario, and calling that block
  // "Scenario · default" described the preset field rather than the contents.
  const scenario = d.preset && d.preset !== "default" ? d.preset : "";
  const head = ctx.el("div", { class: "panelcard-h" },
    ctx.el("span", { class: "section-label flat" },
      scenario ? "Scenario · " + scenario : "What is in this workspace"));
  if (scenario) {
    head.append(ctx.el("button", { class: "linkbtn", onclick: openScenarios },
      "About this scenario ↗"));
  }
  card.append(head);

  // A command that is NOT a url is something you must set up before the scenario
  // works at all -- `oidc` is broken until 127.0.0.1 keycloak is in /etc/hosts.
  // A command that IS a url is just a place to go, and colouring that as a warning
  // would be crying wolf.
  //
  // But "not a url" was not narrow enough either, and this block makes two specific
  // CLAIMS -- that the scenario cannot work until the line exists, and that it needs
  // sudo. `ldap`'s notes indent a phpLDAPadmin credential, so the panel was telling
  // an ldap reader to sudo their way through "log in with DN cn=admin,dc=example,
  // dc=com / admin" before the scenario would work, which is not true of anything.
  // The discriminator is the sentence that INTRODUCES the line, and it is already in
  // the note above it: a hosts entry is the only setup step any preset has.
  // Grouped or not, this card's prose is the SCENARIO's prose. Ungrouped that is
  // the whole flat list; grouped it is the one group marked as the scenario, and the
  // rest are cards of their own below. Reading d.notes in the grouped case would put
  // every Kubernetes fact through here a second time.
  const own = parsed.find((x) => x.g.kind === "scenario");
  const items = own ? own.items : [];
  const introduced = (item) => {
    const before = items[items.indexOf(item) - 1];
    const text = before && before.kind === "prose" ? (before.lines || []).join(" ") : "";
    return /\/etc\/hosts/i.test(text);
  };
  const setup = items.find((i) => i.kind === "cmd"
                                  && !/^https?:\/\//.test(i.value)
                                  && introduced(i));
  if (setup) {
    card.append(ctx.el("div", { class: "setup" },
      ctx.el("span", { class: "setup-i" }, "▲"),
      ctx.el("span", { class: "setup-t" },
        ctx.el("b", {}, "Do this once, on your machine"),
        ctx.el("span", { class: "setup-w" },
          "This scenario cannot work until the line below exists. Needs sudo."),
        ctx.el("code", {}, setup.value)),
      ctx.el("button", { class: "cp", onclick: () => ctx.copy(setup.value) }, "Copy")));
  }

  // A note that names a place the link table ALREADY lists is not a second place,
  // it is the rest of what is known about that one. Monitoring is the plain case:
  // the links say where Grafana is, and the notes say the same thing again plus
  // the password — which is how the same three urls came to be on screen twice,
  // once as rows and once as prose.
  const key = (u) => String(u || "").replace(/\/+$/, "");
  const byUrl = new Map();
  // Across EVERY group, not just this card's own prose. Monitoring's Grafana line
  // lives in the Monitoring group now, and it is still the same row as the Grafana
  // link -- password included, which is the part the link row does not know.
  for (const { items: its } of parsed) {
    for (const it of its) if (it.kind === "place") byUrl.set(key(it.url), it);
  }
  for (const l of d.links || []) {
    const note = byUrl.get(key(l.url));
    if (note) shown.add(note);
    card.append(ctx.placeRow({ label: l.label, url: l.url, kind: l.kind,
                           what: note ? note.what : "", creds: note ? note.creds : "",
                           sub: note ? note.sub : "" }));
  }

  const rest = items.filter((i) => i !== setup && !shown.has(i));
  if (rest.length) {
    card.append(ctx.renderNoteItems(ctx.el("div", { class: "panelcard-b notes" }), rest));
  }
  return card;
}

// ---- detail panel -----------------------------------------------------------
async function selectRepro(name) {
  ctx.setView("workspace");
  ctx.SELECTED = name; ctx.dstate.tab = "overview"; ctx.dstate.points = [];
  // Tear the PREVIOUS repro's panel down first. Leaving it up meant that while the
  // fetch was in flight -- and permanently if it failed -- the list highlighted B
  // while the panel still showed A, with A's destructive Down button wired to A.
  ctx.closeLogs();
  if (ctx.dstate.statsTimer) { clearInterval(ctx.dstate.statsTimer); ctx.dstate.statsTimer = null; }
  ctx.dstate.detail = null;
  ctx.render();
  const panel = ctx.$("#detail");
  panel.innerHTML = "";
  panel.append(ctx.el("div", { class: "placeholder" }, `Loading ${name}…`));
  let detail;
  try { detail = await ctx.api(`/api/repros/${name}/detail`); }
  catch (e) {
    ctx.toast(e.message);
    panel.innerHTML = "";
    panel.append(ctx.el("div", { class: "placeholder" }, `Could not load ${name}.`));
    return;
  }
  if (ctx.SELECTED !== name) return;        // a newer selection won the race
  ctx.dstate.detail = detail;
  ctx.renderDetail();
}
function closeDetail() {
  ctx.setView("home");
  ctx.SELECTED = null; ctx.dstate.detail = null;
  if (ctx.dstate.statsTimer) { clearInterval(ctx.dstate.statsTimer); ctx.dstate.statsTimer = null; }
  ctx.closeLogs();
  ctx.render();
}
function switchTab(t) { ctx.dstate.tab = t; ctx.renderDetail(); }

Object.defineProperties(ctx, {
  "HOME": { enumerable: true, get: () => HOME, set: value => { HOME = value; } },
  "HOME_EVERY": { enumerable: true, get: () => HOME_EVERY },
  "refreshHome": { enumerable: true, get: () => refreshHome },
  "runningRow": { enumerable: true, get: () => runningRow },
  "capacityCard": { enumerable: true, get: () => capacityCard },
  "attentionItems": { enumerable: true, get: () => attentionItems },
  "renderHome": { enumerable: true, get: () => renderHome },
  "openScenarios": { enumerable: true, get: () => openScenarios },
  "noteGroupCard": { enumerable: true, get: () => noteGroupCard },
  "noteItemsByGroup": { enumerable: true, get: () => noteItemsByGroup },
  "scenarioCard": { enumerable: true, get: () => scenarioCard },
  "selectRepro": { enumerable: true, get: () => selectRepro },
  "closeDetail": { enumerable: true, get: () => closeDetail },
  "switchTab": { enumerable: true, get: () => switchTab },
});
export { HOME, HOME_EVERY, refreshHome, runningRow, capacityCard, attentionItems, renderHome, openScenarios, noteGroupCard, noteItemsByGroup, scenarioCard, selectRepro, closeDetail, switchTab };
