import { ctx } from "./shared.js";

// ---- env vars ----------------------------------------------------------------
// FETCHED, not read out of the detail payload. detail() answers this from the
// generated compose file, and a Kubernetes workspace has no such file -- there the
// answer is read out of the running container, which can also legitimately refuse
// ("it is not running"). Hanging that off detail() would let one unreadable
// environment break the whole panel, so the tab asks for it itself and renders the
// refusal in place of the table. Before this the tab simply rendered EMPTY on
// Kubernetes, because the key it read was never in the payload.
async function renderEnv(body, d) {
  const kube = d.runtime === "kubernetes";
  const list = ctx.el("div", {}, ctx.el("p", { class: "empty" }, "loading…"));
  body.append(list);

  let rows = null;
  let doc = null;
  try {
    doc = await ctx.api(`/api/repros/${encodeURIComponent(d.name)}/env`);
    rows = doc.env || [];
  } catch (e) {
    list.innerHTML = "";
    list.append(ctx.el("p", { class: "empty pre" }, String(e.message || e)));
    return;
  }
  list.innerHTML = "";
  // No third column on Kubernetes: it held the remove button, and an empty column
  // under a blank heading reads as a table that failed to render something.
  const head = ctx.el("tr", {}, ctx.el("th", {}, "name"), ctx.el("th", {}, "value"));
  if (!kube) head.append(ctx.el("th", {}, ""));
  const t = ctx.el("table", { class: "dtable" }, head);
  // SAID BEFORE THE TABLE. A recorded value the container is not running was drawn
  // exactly like one it is, which confirms a setting that is not in effect — on the
  // question this tab exists to answer.
  if (doc && doc.drift && doc.drift.length) {
    list.append(ctx.el("p", { class: "banner warn" },
      `${doc.drift.length} recorded value(s) are not what the container is running `
      + `(${doc.drift.join(", ")}). Rocket.Chat is using the old value — set it again `
      + "to re-apply and recreate the container."));
  } else if (doc && doc.live_read === false) {
    // "No drift reported" and "drift could not be checked" are different, and only
    // one of them is reassuring.
    list.append(ctx.el("p", { class: "banner" },
      "The container could not be read, so this is the recorded configuration "
      + "rather than a statement about what is running."));
  }
  for (const e of rows) {
    // Two kinds live in this list and they are not interchangeable: a Rocket.Chat
    // SETTING only works with the OVERWRITE_SETTING_ prefix, a plain env var only
    // works without it. Show the setting id itself and tag it, rather than a wall
    // of OVERWRITE_SETTING_* that hides which is which.
    const isSetting = e.key.startsWith(ENV_SETTING_PREFIX);
    const shown = isSetting ? e.key.slice(ENV_SETTING_PREFIX.length) : e.key;
    const name = ctx.el("td", {}, shown);
    if (isSetting) name.append(ctx.el("span", { class: "pill small" }, "setting"));
    if (e.override) name.append(ctx.el("span", { class: "yours" }, "*"));
    // AMBER, because it wants you: this value is recorded and Rocket.Chat is not
    // running it. Shown per row as well as in the banner, so the one that disagrees
    // is identifiable in a list of forty.
    if (e.drift) name.append(ctx.el("span", { class: "pill small stopped" }, "not live"));
    const act = kube ? null : ctx.el("td", {});
    // No remove button on Kubernetes: the server refuses every write here and says
    // to use helm, so the button could only ever produce a red toast. A control
    // that cannot succeed is worse than no control -- the same rule that keeps the
    // logs and env TABS off a readonly user's panel.
    if (act) {
      act.append(ctx.el("button", {
        class: "btn small danger",
        title: e.override ? "Remove this override" : "Remove this variable from the workspace",
        // The FULL key, not the displayed one — that is what compose holds.
        onclick: () => doEnvChange(d.name, {}, {}, [e.key]),
      }, "remove"));
    }
    const row = ctx.el("tr", {}, name, ctx.el("td", { class: "v" }, e.value));
    if (act) row.append(act);
    t.append(row);
  }
  list.append(t);
  if (!rows.length) list.append(ctx.el("p", { class: "empty" }, "No environment variables."));

  if (kube) {
    // Read from the CONTAINER here, which is a different (and better) source than
    // Compose's file -- the chart contributes variables houston never set, and they
    // are all in this list. Say so, because "* = set by you" would otherwise imply
    // the rest came from houston.
    list.append(ctx.el("p", { class: "hint" },
      "Read live out of the Rocket.Chat container, so this includes what the Helm "
      + "chart sets as well as what houston asked for. * = an override houston "
      + "recorded."));
    list.append(ctx.el("p", { class: "hint pre" },
      "Changing one is a Helm operation, not a container recreate:\n"
      + `  helm -n houston-${d.name} upgrade rocketchat --reuse-values --set extraEnv[0].name=KEY --set extraEnv[0].value=VALUE\n`
      + "For a Rocket.Chat SETTING, use Send an API call instead — that takes effect "
      + "without restarting anything."));
    return;
  }

  list.append(ctx.el("p", { class: "hint" },
    "* = set by you. Changing anything here recreates the Rocket.Chat container — "
    + "MongoDB keeps running, so no data is lost."));

  const kind = ctx.el("select", { class: "input", "aria-label": "kind" },
    ctx.el("option", { value: "setting" }, "Rocket.Chat setting"),
    ctx.el("option", { value: "env" }, "Plain env var"));
  const key = ctx.el("input", { class: "input", placeholder: "Message_AllowEditing", "aria-label": "name" });
  const val = ctx.el("input", { class: "input", placeholder: "false", "aria-label": "value" });
  const why = ctx.el("p", { class: "hint" }, "");
  const explain = () => {
    const setting = kind.value === "setting";
    key.placeholder = setting ? "Message_AllowEditing" : "MY_FLAG";
    val.placeholder = setting ? "false" : "true";
    why.textContent = setting
      ? "Anything you would change in Admin → Settings. The OVERWRITE_SETTING_ prefix"
        + " it needs is added for you — without it Rocket.Chat ignores the variable"
        + " silently. Re-applied on every boot, but the admin UI can still change it"
        + " while the container runs."
      : "A real environment variable (MONGO_URL, NODE_ENV, a feature flag). Passed"
        + " through exactly as typed.";
  };
  kind.addEventListener("change", explain);
  explain();
  const add = ctx.el("button", { class: "btn primary", onclick: () => {
    const k = key.value.trim();
    if (!k) { ctx.toast("enter a name"); return; }
    const payload = { [k]: val.value };
    doEnvChange(d.name, kind.value === "env" ? payload : {},
                kind.value === "setting" ? payload : {}, []);
  } }, "Set + restart");
  list.append(ctx.el("div", { class: "row2" }, kind, key, val, add), why);
}


// ---- backup / restore / upgrade ------------------------------------------------
// A backup is a bundle: the database PLUS the version, preset and parameters that
// produced it. That is what lets "Restore as new" rebuild a whole workspace from
// one file rather than needing a matching repro to already exist.

const fmtBytes = (n) => {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v.toFixed(0) : v.toFixed(1)) + " " + u[i];
};
const shortName = (p) => String(p || "").split("/").pop();

async function renderBackups(body, d) {
  body.append(ctx.el("p", { class: "hint" },
    "Backups hold this workspace's Rocket.Chat database plus the version and preset "
    + "that produced it. Sidecar data (uploads, IdP state) is not included."));
  const bar = ctx.el("div", { class: "row2" },
    ctx.el("button", { class: "btn primary", onclick: () => doBackup(d.name) }, "Back up now"));
  body.append(bar);
  const list = ctx.el("div", {}, ctx.el("p", { class: "empty" }, "loading…"));
  body.append(list);

  let rows = [];
  try {
    rows = (await ctx.api(`/api/backups?name=${encodeURIComponent(d.name)}`)).backups || [];
  } catch (e) {
    list.innerHTML = ""; list.append(ctx.el("p", { class: "empty" }, String(e.message || e)));
    return;
  }
  list.innerHTML = "";
  if (!rows.length) {
    list.append(ctx.el("p", { class: "empty" }, "No backups yet for this workspace."));
    return;
  }
  const t = ctx.el("table", { class: "dtable" }, ctx.el("tr", {},
    ctx.el("th", {}, "bundle"), ctx.el("th", {}, "from"), ctx.el("th", {}, "size"), ctx.el("th", {}, "")));
  for (const b of rows) {
    if (b.error) {
      t.append(ctx.el("tr", {}, ctx.el("td", {}, shortName(b.path)),
        ctx.el("td", { class: "v bad", colspan: "3" }, "unreadable: " + b.error)));
      continue;
    }
    const label = ctx.el("td", {}, shortName(b.path));
    if (b.label) label.append(ctx.el("span", { class: "pill small" }, b.label));
    t.append(ctx.el("tr", {}, label,
      ctx.el("td", { class: "v" }, `RC ${b.rc_version}`),
      ctx.el("td", { class: "v" }, fmtBytes(b.bytes)),
      ctx.el("td", {},
        ctx.el("button", { class: "btn small primary", onclick: () => doRestore(b, d.name) }, "restore"),
        ctx.el("button", { class: "btn small", onclick: () => doRestore(b, "", true) }, "as new"),
        ctx.el("button", { class: "btn small danger", onclick: () => doDeleteBackup(b) }, "delete"))));
  }
  t.append();
  list.append(t);
}

async function doBackup(name) {
  const note = prompt(`Back up ${name}\n\nOptional note stored in the bundle:`, "");
  if (note === null) return;
  try {
    const { job_id } = await ctx.api(`/api/repros/${encodeURIComponent(name)}/backup`,
      { method: "POST", body: JSON.stringify({ label: note }) });
    ctx.streamJob(job_id, `Backing up ${name}`, (res) => {
      ctx.toast(`backed up to ${shortName(res && res.path)}`, "ok");
    });
  } catch (e) { ctx.toast(e.message); }
}

async function doRestore(b, into, asNew = false) {
  // Ask the SERVER whether this is allowed before offering the button's action:
  // a downgrade is refused, and an older-into-newer restore is a migration the
  // user has to opt into. Learning that after a job started is too late.
  let verdict = null;
  if (!asNew && into) {
    try {
      verdict = (await ctx.api("/api/backups/compatibility", {
        method: "POST", body: JSON.stringify({ bundle: b.path, name: into }),
      })).compatibility;
    } catch (e) { ctx.toast(String(e.message || e), "bad"); return; }
    if (verdict && !verdict.allowed) { ctx.toast(verdict.blocked_reason, "bad"); return; }
  }
  const lines = [];
  if (asNew) {
    lines.push(`Create a NEW workspace from ${shortName(b.path)} (RC ${b.rc_version}).`);
  } else {
    lines.push(`Restore ${shortName(b.path)} into ${into}.`,
      "", "Existing collections are DROPPED — this replaces the data, it does not merge.");
  }
  for (const w of ((verdict && verdict.warnings) || [])) lines.push("", "⚠ " + w);
  if (!confirm(lines.join("\n"))) return;
  try {
    const { job_id } = await ctx.api("/api/restore", {
      method: "POST",
      body: JSON.stringify({
        bundle: b.path, name: asNew ? "" : into, new: asNew,
        allow_upgrade: !!(verdict && verdict.requires_flag === "allow_upgrade"),
      }),
    });
    ctx.streamJob(job_id, asNew ? `Restoring ${shortName(b.path)} as a new workspace`
                            : `Restoring ${shortName(b.path)} into ${into}`,
      (res) => { ctx.toast(`restored ${(res && res.name) || ""}`, "ok"); refresh(); });
  } catch (e) { ctx.toast(e.message); }
}

async function doDeleteBackup(b) {
  if (!confirm(`Delete ${shortName(b.path)}?\n\nThis cannot be undone.`)) return;
  try {
    await ctx.api(`/api/backups?path=${encodeURIComponent(b.path)}`, { method: "DELETE" });
    ctx.toast("backup deleted", "ok");
    ctx.renderTab();
  } catch (e) { ctx.toast(String(e.message || e), "bad"); }
}

let UPGRADE_TARGET = "";
function openUpgrade(name, current) {
  UPGRADE_TARGET = name;
  ctx.$("#upgrade-title").textContent = `Upgrade: ${name}`;
  ctx.$("#upgrade-current").textContent = current || "?";
  ctx.$("#upgrade-to").value = "";
  ctx.$("#upgrade-plan").textContent = "";
  ctx.$("#upgrade-plan").className = "hint";
  ctx.$("#upgrade-go").disabled = true;
  ctx.$("#upgrade-dialog").showModal();
}

async function checkUpgradePlan() {
  const to = ctx.$("#upgrade-to").value.trim();
  const out = ctx.$("#upgrade-plan"), go = ctx.$("#upgrade-go");
  go.disabled = true;
  if (!to) { out.textContent = ""; out.className = "hint"; return; }
  out.textContent = "checking…"; out.className = "hint";
  try {
    const s = await ctx.api(`/api/repros/${encodeURIComponent(UPGRADE_TARGET)}/upgrade`
      + `?to=${encodeURIComponent(to)}`);
    if (!s.can_upgrade) { out.textContent = s.reason; out.className = "hint bad"; return; }
    const p = s.plan || {};
    if (!p.allowed) { out.textContent = p.blocked_reason; out.className = "hint bad"; return; }
    const bits = [`${p.from_version} → ${p.to_version}`,
                  `MongoDB ${p.from_mongo}` + (p.from_mongo === p.to_mongo ? "" : ` → ${p.to_mongo}`)];
    out.textContent = bits.join(" · ") + (p.warnings || []).map((w) => "\n⚠ " + w).join("");
    out.className = (p.warnings || []).length ? "hint warn" : "hint ok";
    go.disabled = false;
  } catch (e) {
    out.textContent = String(e.message || e); out.className = "hint bad";
  }
}

async function submitUpgrade() {
  const to = ctx.$("#upgrade-to").value.trim();
  const noBackup = ctx.$("#upgrade-nobackup").checked;
  const name = UPGRADE_TARGET;
  ctx.$("#upgrade-dialog").close();
  if (noBackup && !confirm(
    "Without a pre-upgrade backup there is nothing to roll back to if the "
    + "migrations fail.\n\nContinue?")) return;
  try {
    const { job_id } = await ctx.api(`/api/repros/${encodeURIComponent(name)}/upgrade`,
      { method: "POST", body: JSON.stringify({ to, no_backup: noBackup }) });
    ctx.streamJob(job_id, `Upgrading ${name} to ${to}`, (res) => {
      const errs = (res && res.migration_errors) || [];
      ctx.toast(errs.length
        ? `upgraded to ${res.to_version} with ${errs.length} migration error(s)`
        : `upgraded to ${(res && res.to_version) || to}`, errs.length ? "warn" : "ok");
      refresh();
    });
  } catch (e) { ctx.toast(e.message); }
}

// ---- env vars ---------------------------------------------------------------
// An env var cannot change inside a running container, so this recreates the
// Rocket.Chat service. It goes through streamJob because that recreate takes
// seconds to tens of seconds -- long enough that a silent button looks broken.
const ENV_SETTING_PREFIX = "OVERWRITE_SETTING_";

// `setting` is kept separate from `set` all the way to the server, which adds the
// OVERWRITE_SETTING_ prefix. The browser deliberately does not prepend it, so the
// rule lives in exactly one place.
function doEnvChange(name, set, setting, unset) {
  const changed = Object.keys(set).concat(Object.keys(setting)).concat(unset).join(", ");
  if (unset.length && !confirm(`Remove ${unset.join(", ")} from ${name}?\n\n`
      + "This recreates the Rocket.Chat container. Data is kept.")) return;
  return ctx.runAction(name, "Env", async () => {
    const { job_id } = await ctx.api(`/api/repros/${name}/env`,
      { method: "POST", body: JSON.stringify({ set, setting, unset }) });
    ctx.streamJob(job_id, `Env change on ${name}: ${changed}`);
  });
}


Object.defineProperties(ctx, {
  "renderEnv": { enumerable: true, get: () => renderEnv },
  "fmtBytes": { enumerable: true, get: () => fmtBytes },
  "shortName": { enumerable: true, get: () => shortName },
  "renderBackups": { enumerable: true, get: () => renderBackups },
  "doBackup": { enumerable: true, get: () => doBackup },
  "doRestore": { enumerable: true, get: () => doRestore },
  "doDeleteBackup": { enumerable: true, get: () => doDeleteBackup },
  "UPGRADE_TARGET": { enumerable: true, get: () => UPGRADE_TARGET, set: value => { UPGRADE_TARGET = value; } },
  "openUpgrade": { enumerable: true, get: () => openUpgrade },
  "checkUpgradePlan": { enumerable: true, get: () => checkUpgradePlan },
  "submitUpgrade": { enumerable: true, get: () => submitUpgrade },
  "ENV_SETTING_PREFIX": { enumerable: true, get: () => ENV_SETTING_PREFIX },
  "doEnvChange": { enumerable: true, get: () => doEnvChange },
});
export { renderEnv, fmtBytes, shortName, renderBackups, doBackup, doRestore, doDeleteBackup, UPGRADE_TARGET, openUpgrade, checkUpgradePlan, submitUpgrade, ENV_SETTING_PREFIX, doEnvChange };
