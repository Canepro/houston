import { ctx } from "./shared.js";

// ---- your account: sessions and the way out ---------------------------------
// Server-side sessions are what make any of this possible. HTTP Basic had no
// logout at all -- the browser cached the credential until the tab closed, and
// "revocation is a file edit" was the honest description.
const fmtWhen = (epoch) => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - epoch));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

async function openSessions() {
  ctx.$("#session-title").textContent = `Your sessions`;
  const body = ctx.$("#session-body");
  body.innerHTML = "";
  body.append(ctx.el("p", { class: "empty" }, "loading…"));
  ctx.$("#session-dialog").showModal();
  let rows;
  try { rows = (await ctx.api("/api/sessions")).sessions || []; }
  catch (e) { body.innerHTML = ""; body.append(ctx.el("p", { class: "empty" }, e.message)); return; }
  body.innerHTML = "";
  if (!rows.length) { body.append(ctx.el("p", { class: "empty" }, "No other sessions.")); return; }
  for (const s of rows) {
    const row = ctx.el("div", { class: "jobrow" },
      ctx.el("span", { class: "jstatus " + (s.current ? "done" : "queued") },
        s.current ? "this one" : "other"),
      ctx.el("span", { class: "jkind" }, `${s.label} · seen ${fmtWhen(s.last_seen)}`));
    if (!s.current) {
      row.append(ctx.el("button", {
        class: "btn small danger", onclick: () => revokeSession(s.sid),
      }, "Revoke"));
    }
    body.append(row);
  }
}

async function revokeSession(sid) {
  try { await ctx.api(`/api/sessions?sid=${encodeURIComponent(sid)}`, { method: "DELETE" });
    ctx.toast("session revoked", "ok"); openSessions(); }
  catch (e) { ctx.toast(e.message); }
}

// A real form POST, not fetch: sign-out ends with a redirect to the sign-in page,
// and letting the browser follow it is simpler and works even if this script is
// mid-failure. The logs socket and any SSE stream are closed first so nothing is
// still reading from a session that no longer exists.
function signOut(everywhere) {
  ctx.SIGNING_OUT = true;
  ctx.stopPolling(); ctx.closeLogs(); ctx.closeJobStream();
  if (!everywhere) {
    const f = ctx.el("form", { method: "post", action: "/signout" });
    document.body.append(f); f.submit();
    return;
  }
  fetch("/api/sessions?all=1", { method: "DELETE", credentials: "same-origin" })
    .finally(() => location.assign("/signin?e=signedout"));
}

// ---- people (admin only) -----------------------------------------------------
// The whole dialog is admin-only; a member gets 403 from every endpoint behind it,
// so the entry point is simply not rendered rather than rendered-and-refused.
const ROLE_HELP = {
  admin: "everything, including managing people",
  member: "full workspace lifecycle — today's behaviour",
  readonly: "look only. No logs, env or tokens: those carry real secrets",
};

async function openPeople() {
  const body = ctx.$("#people-body");
  body.innerHTML = "";
  body.append(ctx.el("p", { class: "empty" }, "loading…"));
  ctx.$("#people-dialog").showModal();
  let data;
  try { data = await ctx.api("/api/users"); }
  catch (e) { body.innerHTML = ""; body.append(ctx.el("p", { class: "empty" }, e.message)); return; }
  body.innerHTML = "";
  for (const u of data.users) {
    // Its own row shape rather than Activity's: that one is four fixed cells and
    // this is six, so borrowing it put every person out of step with the header
    // above them. And no role PILL beside the role SELECT -- the select already
    // says which role this is, and saying it twice is not emphasis.
    const label = ctx.el("span", { class: "p-name" }, u.name === ctx.ME ? `${u.name} (you)` : u.name);
    // Blank role == admin is the MIGRATION for accounts made before roles existed,
    // not a default. Saying so here is what stops it looking like a mistake.
    if (u.implicit) {
      label.append(ctx.el("span", { class: "yours", title: "role column is blank, which means admin" },
                     " implicit"));
    }
    const sel = ctx.el("select", { class: "input", "aria-label": `role for ${u.name}`,
      onchange: (e) => changeRole(u.name, e.target.value) },
      ...data.roles.map((r) => ctx.el("option", { value: r, title: ROLE_HELP[r] || "" }, r)));
    sel.value = u.role;
    body.append(ctx.el("div", { class: "prow" },
      label,
      ctx.el("span", { class: "p-sess", title: "signed-in sessions" },
        u.sessions ? `${u.sessions} session${u.sessions === 1 ? "" : "s"}` : "—"),
      sel,
      ctx.el("span", { class: "p-act" },
        ctx.el("button", { class: "btn small", title: "Generate a new password",
                       onclick: () => resetPassword(u.name) }, "reset"),
        ctx.el("button", { class: "btn small danger", title: `Remove ${u.name} and end their sessions`,
                       onclick: () => removePerson(u.name) }, "remove"))));
  }
}

// The password exists in exactly one place for exactly one moment: here.
function showOnce(title, name, password) {
  ctx.$("#pat-title").textContent = title;
  ctx.$("#pat-body").textContent =
    `${name}\n\nPassword: ${password}\n\n`
    + "Shown once. houston stores only a scrypt hash, so nobody — including you —\n"
    + "can read it back. Send it however you would send anything else, and have\n"
    + "them change it after signing in.";
  ctx.PAT_HEADERS = password;      // so "Copy headers" copies the password
  ctx.$("#pat-dialog").showModal();
}

async function addPerson() {
  const name = ctx.$("#new-user").value.trim();
  if (!name) { ctx.toast("enter a name"); return; }
  try {
    const r = await ctx.api("/api/users", { method: "POST",
      body: JSON.stringify({ name, role: ctx.$("#new-role").value }) });
    ctx.$("#new-user").value = "";
    openPeople();
    showOnce(`Account created: ${r.name}`, `${r.name} · ${r.role}`, r.password);
  } catch (e) { ctx.toast(e.message); }
}

async function changeRole(name, role) {
  try {
    const r = await ctx.api(`/api/users/${encodeURIComponent(name)}/role`,
      { method: "POST", body: JSON.stringify({ role }) });
    ctx.toast(`${name} is now ${r.role}` + (r.sessions_ended ? ` (${r.sessions_ended} session(s) ended)` : ""), "ok");
    openPeople();
    if (name === ctx.ME) location.reload();     // your own menu just changed
  } catch (e) { ctx.toast(e.message); openPeople(); }
}

async function resetPassword(name) {
  if (!confirm(`Reset ${name}'s password?\n\nTheir current one stops working and every session they have ends.`)) return;
  try {
    const r = await ctx.api(`/api/users/${encodeURIComponent(name)}/password`, { method: "POST" });
    openPeople();
    showOnce(`Password reset: ${name}`, name, r.password);
  } catch (e) { ctx.toast(e.message); }
}

async function removePerson(name) {
  if (!confirm(`Remove ${name}?\n\nThey are signed out immediately and can no longer sign in.\nTheir workspaces are left alone.`)) return;
  try {
    await ctx.api(`/api/users/${encodeURIComponent(name)}`, { method: "DELETE" });
    ctx.toast(`${name} removed`, "ok"); openPeople();
  } catch (e) { ctx.toast(e.message); }
}

// ---- wiring -----------------------------------------------------------------
ctx.$("#people-close").addEventListener("click", () => ctx.$("#people-dialog").close());
ctx.$("#people-add-btn").addEventListener("click", addPerson);
// ---- account menu ----------------------------------------------------------
function closeMe() {
  ctx.$("#me-menu").hidden = true;
  ctx.$("#whoami").setAttribute("aria-expanded", "false");
}
ctx.$("#whoami").addEventListener("click", (e) => {
  e.stopPropagation();
  const m = ctx.$("#me-menu");
  const open = m.hidden;
  m.hidden = !open;
  ctx.$("#whoami").setAttribute("aria-expanded", String(open));
  if (open) {
    ctx.$("#me-name").textContent = ctx.ME;
    ctx.$("#me-role").textContent = ctx.MY_ROLE || "";
    ctx.$("#me-people").hidden = ctx.MY_ROLE !== "admin";
    ctx.$("#me-sessions-n").textContent = "";
    // Fetched when the menu opens rather than on every poll: it is one line of
    // context, and nobody needs it four seconds fresh.
    ctx.api("/api/sessions").then((r) => {
      const n = (r.sessions || []).length;
      ctx.$("#me-sessions-n").textContent = n ? `${n} active` : "";
    }).catch(() => {});
  }
});
document.addEventListener("click", closeMe);
// ---- the narrow layout's two disclosures ------------------------------------
// Both are body classes rather than inline styles, so the CSS decides whether they
// mean anything: above 760px the popover and the pane are laid out as columns and
// these classes select nothing. A layout switched by JS is a layout that is wrong
// until the next resize event.
function closeNav() {
  document.body.classList.remove("nav-open");
  ctx.$("#nav-toggle").setAttribute("aria-expanded", "false");
}
ctx.$("#nav-toggle").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = !document.body.classList.contains("nav-open");
  document.body.classList.toggle("nav-open", open);
  ctx.$("#nav-toggle").setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", closeNav);
ctx.$("#toplinks").addEventListener("click", closeNav);
ctx.$("#me-menu").addEventListener("click", (e) => e.stopPropagation());
ctx.$("#me-sessions").addEventListener("click", () => { closeMe(); openSessions(); });
ctx.$("#me-people").addEventListener("click", () => { closeMe(); openPeople(); });
ctx.$("#me-passwd").addEventListener("click", () => { closeMe(); openPasswd(); });
ctx.$("#me-out").addEventListener("click", () => { closeMe(); signOut(false); });
ctx.$("#session-close").addEventListener("click", () => ctx.$("#session-dialog").close());
// ---- change your own password ----------------------------------------------
function openPasswd() {
  const f = ctx.$("#passwd-form");
  f.old.value = ""; f.new.value = "";
  ctx.$("#passwd-err").hidden = true;
  ctx.$("#passwd-dialog").showModal();
  f.old.focus();
}
ctx.$("#passwd-cancel").addEventListener("click", () => ctx.$("#passwd-dialog").close());
ctx.$("#passwd-go").addEventListener("click", async () => {
  const f = ctx.$("#passwd-form");
  const err = ctx.$("#passwd-err");
  err.hidden = true;
  if (!f.old.value || !f.new.value) {
    err.textContent = "Both fields are needed."; err.hidden = false; return;
  }
  try {
    // The endpoint ends every OTHER session and re-issues this one, so there is
    // nothing to do here but say so -- no reload, no re-login.
    const r = await ctx.api("/api/me/password", {
      method: "POST",
      body: JSON.stringify({ old: f.old.value, new: f.new.value }),
    });
    ctx.$("#passwd-dialog").close();
    const n = r.sessions_ended || 0;
    ctx.toast(n ? `Password changed. ${n} other session(s) signed out.` : "Password changed.", "ok");
  } catch (e) {
    err.textContent = e.message; err.hidden = false;
  }
});
ctx.$("#session-all").addEventListener("click", () => {
  if (confirm("Sign out of every browser you have signed in from?")) signOut(true);
});
ctx.$(".brand").addEventListener("click", ctx.goHome);
// Refresh re-probes the cluster too, which the poll deliberately does not: that is
// what somebody presses after installing k3s or starting a cluster.
ctx.$("#btn-refresh").addEventListener("click", () => { ctx.loadRepros(); ctx.refreshKube(); });

Object.defineProperties(ctx, {
  "fmtWhen": { enumerable: true, get: () => fmtWhen },
  "openSessions": { enumerable: true, get: () => openSessions },
  "revokeSession": { enumerable: true, get: () => revokeSession },
  "signOut": { enumerable: true, get: () => signOut },
  "ROLE_HELP": { enumerable: true, get: () => ROLE_HELP },
  "openPeople": { enumerable: true, get: () => openPeople },
  "showOnce": { enumerable: true, get: () => showOnce },
  "addPerson": { enumerable: true, get: () => addPerson },
  "changeRole": { enumerable: true, get: () => changeRole },
  "resetPassword": { enumerable: true, get: () => resetPassword },
  "removePerson": { enumerable: true, get: () => removePerson },
  "closeMe": { enumerable: true, get: () => closeMe },
  "closeNav": { enumerable: true, get: () => closeNav },
  "openPasswd": { enumerable: true, get: () => openPasswd },
});
export { fmtWhen, openSessions, revokeSession, signOut, ROLE_HELP, openPeople, showOnce, addPerson, changeRole, resetPassword, removePerson, closeMe, closeNav, openPasswd };
