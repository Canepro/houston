import { ctx } from "./shared.js";

"use strict";
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids) n.append(kid);
  return n;
};

// kind: "error" (default) | "ok" | "info". Toasts were unconditionally red, so
// "copied" and "pruned 3" flashed like failures; and every toast shared one fixed
// position, so a repeating failure (the 4s poll against a bad token) piled
// unreadable banners exactly on top of each other.
function toast(msg, kind = "error") {
  let stack = $("#toasts");
  if (!stack) { stack = el("div", { id: "toasts", class: "toasts" }); document.body.append(stack); }
  const last = stack.lastElementChild;
  if (last && last.textContent === msg) last.remove();   // collapse an identical repeat
  const t = el("div", { class: "toast " + kind, role: "status" }, msg);
  stack.append(t);
  while (stack.childElementCount > 4) stack.removeChild(stack.firstChild);
  setTimeout(() => t.remove(), 4000);
}

// EVERY url on screen is the one the server reported, shown and linked verbatim.
//
// There used to be a rewrite here that swapped `localhost` for whatever host the
// GUI was loaded from, so that links stayed clickable when `serve` is reached
// through a proxy or a remote lab. It is gone, deliberately: a workspace's
// ROOT_URL is what Rocket.Chat itself is configured with, so it is the address
// that identifies the workspace, and the rewrite meant the interface showed a
// number that appears in no config file anywhere. Applying it to an href but not
// to the label also put two different addresses for one workspace on one screen.
//
// The cost is real and is accepted: from a browser that is not on the docker host,
// `http://localhost:3000` is that browser's own machine, so the link will not
// open the workspace. It is still the correct thing to display, and copying it is
// what a support engineer pastes into a ticket.

// Set once the server says a login is in force. Until then every 401 is a token
// problem, not an expired session, and bouncing to /signin would be wrong.
let ACCOUNTS = false;
let MY_ROLE = "";
// What this session may do, so the interface can say so BEFORE the click rather
// than refusing after it. The server is the boundary -- every one of these is
// enforced in `guard` regardless -- but a button that always answers with a red
// toast reads as a broken feature, not as a permission.
// Token mode has no roles, so everything is allowed there exactly as before.
const canWrite = () => MY_ROLE !== "readonly";
const canAdmin = () => MY_ROLE === "admin";
const READONLY_WHY = "Your role is readonly. Workspace logs carry LDAP bind "
  + "passwords and OAuth secrets, so readonly cannot read them either.";
let SIGNING_OUT = false;

// A session can expire mid-session (12h idle / 7d absolute) or be revoked from
// another browser. Both arrive as a 401 on whatever the page happened to be
// doing -- the 4s poll, an SSE reconnect, a click. Without this the dashboard
// just started failing silently, which is the failure mode the old
// no-logout-no-login-page design had no answer for either.
function toSignIn(reason) {
  if (SIGNING_OUT) return;
  SIGNING_OUT = true;
  const next = encodeURIComponent(location.pathname + location.search);
  location.assign(`/signin?e=${reason}&next=${next}`);
}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body) headers["Content-Type"] = "application/json";
  // same-origin credentials so the session cookie rides along; it is HttpOnly,
  // so this file can neither read nor forge it.
  const r = await fetch(path, Object.assign({ credentials: "same-origin" }, opts, { headers }));
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { toSignIn("expired"); throw new Error("signed out"); }
  if (!r.ok) {
    // The STATUS rides along, because "retry in three seconds" and "this will
    // never work" are different answers and the message alone cannot tell them
    // apart. src/lib/errors.ts assigns the code by class: 409 is a refusal (not running,
    // no metrics-server), 502 is docker, 400 is the request itself.
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

// The same call for a MULTIPART body. `api()` sets Content-Type: application/json
// whenever there is a body, which is exactly wrong for a FormData upload -- the
// browser has to set its own boundary. So this shares everything that matters (the
// same-origin session cookie, the 401 redirect, the status-carrying error) and
// differs only in not touching Content-Type.
//
// The config-import preview used a bare `fetch` for this reason and lost the 401
// with it: an expired session showed an error inside a dialog that could no longer
// do anything, instead of returning the reader to sign-in.
async function apiForm(path, opts = {}) {
  const r = await fetch(path, Object.assign({ credentials: "same-origin" }, opts));
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { toSignIn("expired"); throw new Error("signed out"); }
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

// ---- where is this browser? -------------------------------------------------
// Nothing is DETECTED here. Whether `serve` is on EC2, on a colleague's desktop or
// on the reader's own laptop is not a question this needs answered -- the only thing
// that matters is whether the browser and the workspaces are on the same machine,
// and the browser already knows that: it is the address in its own URL bar. No cloud
// metadata, no guessing from a hostname, no new endpoint.
//
// Loopback => `serve` and the browser are the same box, and every localhost link in
// this UI is correct. Anything else => they are not, and "localhost" names the
// READER'S machine, where nothing is running.
// The whole of 127.0.0.0/8, not just 127.0.0.1: every address in it is this machine
// talking to itself, so a GUI opened at 127.0.0.2 is no more remote than one opened
// at 127.0.0.1 and must not be told otherwise.
const LOOPBACK_HOSTS = ["localhost", "::1", "[::1]", ""];
function isLoopbackHost(h) {
  return LOOPBACK_HOSTS.includes(h) || /^127\.\d+\.\d+\.\d+$/.test(h);
}
function remoteHost() {
  return isLoopbackHost(location.hostname) ? "" : location.hostname;
}
// A workspace bound to one of these is reachable from another machine; bound to
// anything else it answers only on the box that runs it. "" means the workspace
// predates the metadata key, so nothing is claimed either way.
const WIDE_BINDS = ["0.0.0.0", "::", "*"];

// ---- repro list (master) ----------------------------------------------------
let ALL_REPROS = [];
let SELECTED = null;
// What the stage is showing: "home" when nothing is picked, "workspace" for
// the selected one, "activity" for the box-wide log. The rail selection and
// the view are separate on purpose -- opening Activity must not silently
// deselect the workspace you were working on.
let VIEW = "home";
// Every view change goes through here, so "what is on the stage" and "what the
// top bar says is current" cannot disagree. They did: Activity and Scenarios were
// reachable and nothing led back, because the brand was a <div> and no link was
// ever marked.
function setView(v) {
  VIEW = v;
  for (const [id, name] of [["#btn-home", "home"], ["#btn-jobs", "activity"],
                            ["#btn-clusters", "clusters"],
                            ["#btn-scenarios", "scenarios"]]) {
    const b = $(id);
    if (b) b.toggleAttribute("aria-current", VIEW === name);
  }
}
function goHome() {
  SELECTED = null;
  ctx.closeLogs();
  if (dstate.statsTimer) { clearInterval(dstate.statsTimer); dstate.statsTimer = null; }
  dstate.detail = null;
  setView("home");
  ctx.renderHome();
  ctx.render();
}
const view = { filter: "", status: "", sort: "name",
               scope: localStorage.getItem("rc_scope") || "all" };
// lifecycle.list_repros() reports "?" when docker is down, which is not a usable
// CSS class token (and had no rule), so those cards rendered unstyled.
const stateClass = (s) => (s === "?" ? "unknown" : s);
// Colour the health badge from HEALTH, not state: "Up 2 minutes (unhealthy)" is
// state=running + health=unhealthy, and colouring by state painted it GREEN.
const HEALTH_TONE = { running: "green", bad: "bad", warn: "warn", stopped: "warn" };
function healthClass(r) {
  const h = (r.health || "").toLowerCase();
  if (h.includes("unhealthy")) return "bad";
  // AMBER, not green. A degraded workspace is running -- something it needs is not --
  // so falling through to stateClass painted it green, which is this file's word for
  // "fine". Colour is a signal here, never decoration: amber is "wants you".
  if (h === "degraded") return "warn";
  if (h.includes("starting")) return "warn";
  if (h === "healthy" || h === "running") return "running";
  return stateClass(r.state);
}
let ME = "";                  // the signed-in user, "" when nobody is signed in
// A job that has not reached a terminal state. "queued" is one: heavy and
// measurement jobs wait for a slot before they start, and testing only for
// "running" made every one of them look like it had already finished.
const jobActive = (s) => s === "running" || s === "queued";
const dstate = { tab: "overview", detail: null, statsTimer: null, points: [] };

// Restart counts already seen, keyed "<workspace>/<pod>". A restart COUNT is
// cumulative and says nothing about now: a microservices workspace whose
// ddp-streamer came up before NATS restarts two or three times during a normal boot
// and is then stable for days. Warning on the total meant "keeps restarting" -- present
// tense -- sat on a healthy workspace forever, which is how a banner teaches people to
// ignore it. `src/core/lifecycle/ready.ts`'s own boot watcher already had the right rule
// (`rc >= 2 && rc > seen.restarts`); this is that rule, on this side.
const RESTARTS_SEEN = {};

function restartsClimbing(workspace, service, count) {
  const key = `${workspace}/${service}`;
  const before = RESTARTS_SEEN[key];
  RESTARTS_SEEN[key] = count;
  return before !== undefined && count > before;
}

async function loadRepros() {
  try {
    const [{ repros }, health] = await Promise.all([
      api("/api/repros"), api("/api/health").catch(() => ({ docker: false })),
    ]);
    ALL_REPROS = repros;
    ctx.refreshEdgeBadge();          // its own request: /api/health must stay cheap
    ctx.refreshClusterBadge();       // ditto, and it probes nothing -- see the note there
    // Identity comes from /api/session now, not from a field bolted onto
    // /api/health -- an endpoint left open for uptime checks should not be
    // reading credentials. Empty on a single-user box (no accounts, no login),
    // in which case the chip stays hidden and every card renders as it always has.
    try {
      const me = await api("/api/session");
      ACCOUNTS = !!me.accounts;
      ME = me.user || "";
      MY_ROLE = me.role || "";
    } catch (_) { /* signed out; api() has already redirected */ }
    // The top bar too: "+ New repro" and "Prune down" are member+, so a readonly
    // session should not be offered them at all.
    for (const [sel, ok] of [["#btn-new", canWrite()], ["#btn-prune", canWrite()]]) {
      const b = $(sel); if (b) b.hidden = !ok;
    }
    // Only worth offering once somebody else's workspaces can appear.
    const scope = $("#scope-filter");
    if (scope) {
      scope.hidden = !ME || !ALL_REPROS.some((r) => (r.owner || r.created_by) &&
                                                    (r.owner || r.created_by) !== ME);
      scope.value = view.scope;
    }
    const who = $("#whoami");
    who.textContent = ME + (MY_ROLE && MY_ROLE !== "admin" ? ` · ${MY_ROLE}` : "");
    who.hidden = !ME;
    ctx.DOCKER_OK = !!health.docker;
    paintEngines();
    if (SELECTED && !ALL_REPROS.find((r) => r.name === SELECTED)) ctx.closeDetail();
    ctx.render();
    ctx.refreshHome();
  } catch (e) { toast(e.message); }
}

// ---- the two engines --------------------------------------------------------
// `KUBE` is fetched on its own, NOT on the four-second poll: `preflight()` shells out
// to kubectl several times, and /api/health is the cheap unauthenticated call every
// open tab makes. Same reasoning as the edge badge, and the same facts `doctor`
// reports, from the same probe -- so the footer and the report cannot disagree about
// which cluster you are on.
let KUBE = null;

async function refreshKube() {
  try { KUBE = await api("/api/kubernetes"); }
  catch (_) { KUBE = null; }                    // no permission, or no gui extra
  paintEngines();
}

// The footer says what each ENGINE is doing; the header button says what it does.
// "docker: up" in the header was the whole environment when Docker was the only
// runtime -- it is one engine of two now, and a workspace can run in either.
function paintEngines() {
  const k = KUBE || {};
  const kube = !k.usable ? "not set up"
    : k.reachable ? `${k.distribution || "cluster"} ${k.context || ""}`.trim()
    : k.can_provision ? "no cluster yet" : "no cluster";
  const el = $("#sb-engines");
  if (el) el.textContent = `docker: ${ctx.DOCKER_OK ? "up" : "down"} · k8s: ${kube}`;
  // Red only when NOTHING can run a workspace. Docker being down is not a broken box
  // on a machine whose Kubernetes is up, and saying so would be crying wolf at
  // somebody whose k3s is working perfectly.
  const badge = $("#doctor-badge");
  if (badge) {
    const dead = !ctx.DOCKER_OK && !(k.usable && k.reachable);
    badge.className = "chip " + (dead ? "down" : "up");
    badge.title = dead ? "Nothing here can run a workspace — run the environment check"
                       : "Run the environment check";
  }
}

Object.defineProperties(ctx, {
  "$": { enumerable: true, get: () => $ },
  "el": { enumerable: true, get: () => el },
  "toast": { enumerable: true, get: () => toast },
  "ACCOUNTS": { enumerable: true, get: () => ACCOUNTS, set: value => { ACCOUNTS = value; } },
  "MY_ROLE": { enumerable: true, get: () => MY_ROLE, set: value => { MY_ROLE = value; } },
  "canWrite": { enumerable: true, get: () => canWrite },
  "canAdmin": { enumerable: true, get: () => canAdmin },
  "READONLY_WHY": { enumerable: true, get: () => READONLY_WHY },
  "SIGNING_OUT": { enumerable: true, get: () => SIGNING_OUT, set: value => { SIGNING_OUT = value; } },
  "toSignIn": { enumerable: true, get: () => toSignIn },
  "api": { enumerable: true, get: () => api },
  "apiForm": { enumerable: true, get: () => apiForm },
  "LOOPBACK_HOSTS": { enumerable: true, get: () => LOOPBACK_HOSTS },
  "isLoopbackHost": { enumerable: true, get: () => isLoopbackHost },
  "remoteHost": { enumerable: true, get: () => remoteHost },
  "WIDE_BINDS": { enumerable: true, get: () => WIDE_BINDS },
  "ALL_REPROS": { enumerable: true, get: () => ALL_REPROS, set: value => { ALL_REPROS = value; } },
  "SELECTED": { enumerable: true, get: () => SELECTED, set: value => { SELECTED = value; } },
  "VIEW": { enumerable: true, get: () => VIEW, set: value => { VIEW = value; } },
  "setView": { enumerable: true, get: () => setView },
  "goHome": { enumerable: true, get: () => goHome },
  "view": { enumerable: true, get: () => view },
  "stateClass": { enumerable: true, get: () => stateClass },
  "HEALTH_TONE": { enumerable: true, get: () => HEALTH_TONE },
  "healthClass": { enumerable: true, get: () => healthClass },
  "ME": { enumerable: true, get: () => ME, set: value => { ME = value; } },
  "jobActive": { enumerable: true, get: () => jobActive },
  "dstate": { enumerable: true, get: () => dstate },
  "RESTARTS_SEEN": { enumerable: true, get: () => RESTARTS_SEEN },
  "restartsClimbing": { enumerable: true, get: () => restartsClimbing },
  "loadRepros": { enumerable: true, get: () => loadRepros },
  "KUBE": { enumerable: true, get: () => KUBE, set: value => { KUBE = value; } },
  "refreshKube": { enumerable: true, get: () => refreshKube },
  "paintEngines": { enumerable: true, get: () => paintEngines },
});
export { $, el, toast, ACCOUNTS, MY_ROLE, canWrite, canAdmin, READONLY_WHY, SIGNING_OUT, toSignIn, api, apiForm, LOOPBACK_HOSTS, isLoopbackHost, remoteHost, WIDE_BINDS, ALL_REPROS, SELECTED, VIEW, setView, goHome, view, stateClass, HEALTH_TONE, healthClass, ME, jobActive, dstate, RESTARTS_SEEN, restartsClimbing, loadRepros, KUBE, refreshKube, paintEngines };
