import { ctx } from "./shared.js";

// ---- the three axes: where it runs, how it is arranged, how many -------------
// Populated from /api/settings, never from a list written here. The same reasoning
// as PRIVILEGED_FIELDS a few lines up: two places deciding the same thing is how
// the dialog ends up offering a combination the service layer refuses.
let RUNTIMES = [];

const RUNTIME_LABEL = { docker: "Docker Compose", kubernetes: "Kubernetes" };

// WHICH Kubernetes, from the server's probe rather than from a word written here.
// The label was the literal "Kubernetes (kind)", which was true while kind was the
// only way to have a cluster and became a lie the moment houston could adopt one:
// on a box with no kind and a running k3s, the card named a cluster that would not
// be touched -- the same defect `doctor` had, in the other front-end.
//
// The branch order is `plan_cluster`'s, so the card cannot promise a different
// cluster than the create will use: kind present wins even when something else is
// running, because houston makes its own.
function runtimeLabel(name) {
  // JUST "Kubernetes". This used to read "Kubernetes (k3s)" or "Kubernetes (kind)",
  // naming whatever local cluster the box happened to have -- helpful when a local
  // cluster was the only Kubernetes there was, and misleading the moment EKS existed:
  // somebody heading for a cluster in AWS was told the card meant k3s, and reasonably
  // read that as the wrong choice. Reported from a real screen.
  //
  // The information did not go anywhere. The cluster picker sits directly under this
  // card and names the cluster that will actually be used, including "a local cluster
  // will be created" when there is none -- which is the same fact, said where the
  // choice is made rather than in the label of the thing above it.
  if (name !== "kubernetes") return RUNTIME_LABEL[name] || name;
  return "Kubernetes";
}
const DEPLOYMENT_LABEL = {
  monolith: "monolith — one Rocket.Chat",
  "multi-instance": "multi-instance — several behind a load balancer",
  microservices: "microservices — split into services",
};
// What CHANGES when you pick one, said where the choice is made. Not decoration:
// the runtime decides which other commands will work on this workspace for the
// rest of its life, and that is not recoverable from the word "Kubernetes".
// What the ARRANGEMENT builds, since that is the choice directly above it. What
// the runtime cannot do is said once, by the absence line in Advanced, which is
// generated from the server's refusal registry -- so this no longer repeats "HTTPS
// is not available here", which was the same fact in two places and only one of
// them would have been updated when it changes.
const DEPLOYMENT_NOTE = {
  monolith: "One Rocket.Chat process.",
  "multi-instance": "Several Rocket.Chat containers behind a load balancer.",
  microservices: "Rocket.Chat plus presence, ddp-streamer, account, authorization "
    + "and stream-hub, each its own deployment.",
};

// TWO functions, not one, and the split is load-bearing. Changing the RUNTIME
// repopulates the arrangement list and resets it; changing the ARRANGEMENT must
// only show or hide the fields that depend on it. Wiring one function to both
// events made every arrangement choice snap straight back to the runtime's
// default -- picking `monolith` on Kubernetes recorded `microservices`, and the
// dialog looked right the whole time. Found by clicking it, not by a test.
// What a card says, beyond its name. Everything measurable comes from the server
// (`/api/settings` -> runtimes[].cost, built from the same constants check_capacity
// spends), so a card cannot quote a figure the preflight will contradict. Only the
// one-line "what this is for" is written here, because it is a judgement rather
// than a measurement.
const RUNTIME_PITCH = {
  docker: "Every command works, including HTTPS and load tests.",
  kubernetes: "Helm, real pods, microservices. SCRAM auth available.",
};

function fmtGb(mb) {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

// The runtime fork. Rendered rather than written into the markup because the list
// of runtimes comes from the server -- the same table the CLI resolves against, so
// the dialog cannot offer a combination the service layer refuses.
function renderRuntimeAxes() {
  const rt = ctx.$("#runtime-value").value || (RUNTIMES[0] && RUNTIMES[0].name) || "docker";
  const forks = ctx.$("#runtime-forks");
  forks.innerHTML = "";
  for (const spec of RUNTIMES) {
    const chosen = spec.name === rt;
    const cost = (spec.cost || {})[spec.default_deployment] || {};
    const card = ctx.el("button", {
      type: "button", class: "fork", "aria-pressed": String(chosen),
      onclick: () => pickRuntime(spec.name),
    },
      ctx.el("span", { class: "fork-n" }, ctx.el("span", { class: "fork-dot" }),
         runtimeLabel(spec.name)),
      // What it BUILDS, not what it might weigh. The memory figure was an
      // estimate dressed as a fact -- it depends on the preset, the arrangement
      // and what else is running -- and the free-space line in this same header
      // answers "will it fit" from the box itself, which is the question.
      ctx.el("div", { class: "fork-cost" }, cost.shape || ""),
      ctx.el("div", { class: "fork-can" }, RUNTIME_PITCH[spec.name] || ""));
    forks.append(card);
  }
  const spec = RUNTIMES.find((r) => r.name === rt);

  // Arrangement: a segmented control INSIDE this section, because it is dependent
  // on the runtime rather than a peer of it. Two peer dropdowns claimed to be
  // independent and the code then had to fight that -- it produced two live bugs,
  // the arrangement snapping back to the runtime default being one of them.
  const seg = ctx.$("#deployment-seg");
  seg.innerHTML = "";
  const deployments = spec ? spec.deployments : [];
  // A value outside this runtime's list can never stand. Choosing the runtime's
  // default when the runtime CHANGES is `pickRuntime`'s job, not this function's --
  // see the comment there for why "keep it if it is still legal" is wrong.
  if (!deployments.includes(ctx.$("#deployment-value").value)) {
    ctx.$("#deployment-value").value = spec ? spec.default_deployment : "";
  }
  for (const d of deployments) {
    seg.append(ctx.el("button", {
      type: "button", "aria-pressed": String(ctx.$("#deployment-value").value === d),
      onclick: () => pickDeployment(d),
    }, d));
  }
  ctx.$("#runtime-hint").textContent =
    DEPLOYMENT_NOTE[ctx.$("#deployment-value").value] || "";

  // The one control a runtime ADDS rather than removes, and it belongs here in
  // "where it runs" rather than in Advanced: it decides whether this workspace's
  // MongoDB requires a password.
  const extra = ctx.$("#runtime-extra");
  extra.innerHTML = "";
  if (rt === "kubernetes") {
    extra.append(ctx.el("label", {},
      ctx.el("input", { type: "checkbox", name: "mongo_operator", id: "mongo-operator" }),
      " MongoDB via the official operator (adds SCRAM authentication)"));
  }
  syncAdvancedForRuntime(spec);
  syncDeploymentFields();
}

function pickRuntime(name) {
  if (ctx.$("#runtime-value").value === name) return;
  ctx.$("#runtime-value").value = name;
  // The new runtime's DEFAULT, unconditionally -- not "keep the old one if it is
  // still legal". Both runtimes offer `monolith`, so keeping it looked considerate
  // and produced a real divergence: `--runtime k8s` on the CLI defaults to
  // microservices, and the dialog would hand you monolith because that is what
  // Compose had selected a moment earlier. The value sitting there was never a
  // choice about Kubernetes.
  const spec = RUNTIMES.find((r) => r.name === name);
  ctx.$("#deployment-value").value = spec ? spec.default_deployment : "";
  renderRuntimeAxes();
}

function pickDeployment(name) {
  ctx.$("#deployment-value").value = name;
  renderRuntimeAxes();
}

// Advanced follows the runtime too, and it is a DIFFERENT SET rather than a
// cosmetic difference: the fields below do not work on Kubernetes, and each was
// once accepted and silently dropped. The list comes from the server's own refusal
// registry, so the form cannot claim something is unavailable that has since been
// built -- `--reg-token` and every preset were on that list until they were.
const ADV_GONE_LABEL = {
  https: "HTTPS", domain: "a public domain",
  fresh: "rebuild and DELETE data",
};

// The rows behind the cluster picker, so the note below can say what a choice MEANS
// without asking the server again or re-deriving anything.
let KUBE_CLUSTERS = [];

// What choosing THIS cluster commits you to, said in section 2 where the choice is
// made rather than discovered afterwards. Two facts, and only for a managed cluster:
// it bills for as long as it exists, and without a public name the workspace is
// reachable only by a port-forward -- which on a cluster you are paying to have
// somewhere else is the one outcome that wastes the whole point of it.
//
// The domain field is NOT duplicated here. One field, made findable: the button
// opens Advanced and puts the cursor in it, so there is still exactly one place that
// value lives.
// THIS MACHINE'S MEMORY, shown only when this machine is where the workspace lands.
// It sat in section 2's header unconditionally, so choosing an EKS cluster left
// "5.4 GB free · room for about 4 more" on screen -- a number about a laptop, next to
// a choice to run in AWS, and "room for about 4 more" is simply false there. The
// capacity that matters on a managed cluster is the cluster's, which `cluster status`
// reports and this dialog does not have.
let MACHINE_ROOM = null;

function clusterLabel(c) {
  // WHAT TO SHOW for a cluster in a picker. An EKS context is
  // `arn:aws:eks:<region>:<account>:cluster/<name>` — sixty-odd characters, of which
  // the name and the region are the two a person needs and the account id is not.
  // With two suffixes appended that made a ninety-five character `<option>`, and a
  // native select cannot shrink text: it ran out of its box.
  //
  // `short` and `region` come from the SERVER, beside `billable`, because deriving
  // them here would be a second copy of a rule the service already owns. The fallback
  // to `context` keeps an older payload rendering rather than showing "undefined".
  const name = (c && c.short) || (c && c.context) || "";
  const region = (c && c.region) || "";
  return region ? `${name} (${region})` : name;
}

function runsOnThisMachine() {
  const spec = RUNTIMES.find((r) => r.name === ctx.$("#runtime-value").value);
  if (!spec || spec.name !== "kubernetes") return true;      // Compose is always here
  const csel = ctx.$("#context-select");
  const chosen = csel && (csel.value
    ? KUBE_CLUSTERS.find((c) => c.context === csel.value)
    : KUBE_CLUSTERS.find((c) => c.is_default));
  // No cluster known yet means the local one houston would build.
  return !chosen || !chosen.billable;
}

function syncRoomLine() {
  const el_ = ctx.$("#create-room");
  if (!el_) return;
  if (!MACHINE_ROOM || !runsOnThisMachine()) { el_.textContent = ""; return; }
  const free = Math.max(0, (MACHINE_ROOM.available_mb || 0) - (MACHINE_ROOM.reserve_mb || 0));
  el_.textContent = `${fmtGb(free)} free · room for about ${MACHINE_ROOM.room} more`;
}

function syncLocalCaOption() {
  // "Local certificate" CANNOT work on a cluster that is not on this machine, and the
  // reason is a security gate rather than a missing feature: it would copy houston's
  // CA PRIVATE KEY into a Secret in somebody else's cluster, and that key can mint a
  // certificate for any name this box trusts. `_kubernetes_tls_plan` refuses it with
  // GATE_UNAPPROVED_CLUSTER.
  //
  // Removed rather than left to be refused, because that is this dialog's rule: an
  // option that cannot succeed is worse than no option — it invites a click, costs a
  // filled-in form, and explains itself only after the submit.
  //
  // ONLY WHEN WE POSITIVELY KNOW. `runsOnThisMachine()` answers true for Compose, for
  // an unknown cluster and for the local one houston would build, and false only when
  // the chosen cluster is billable. Taking a working choice away on a guess would be
  // the worse mistake of the two, so uncertainty keeps the option.
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
      "Local certificate — offline, no domain (run houston trust-ca once)"));
  }
}

function syncClusterNote() {
  const note = ctx.$("#cluster-note");
  const csel = ctx.$("#context-select");
  const row = ctx.$("#context-row");
  syncRoomLine();
  // The cluster decides this, not only the runtime — picking a managed cluster with
  // Kubernetes already selected has to take the option away too.
  syncLocalCaOption();
  if (!note || !csel) return;
  // WHAT "DECIDE FOR ME" WOULD ACTUALLY DECIDE. Leaving the picker alone is the most
  // likely thing anybody does, and on a box whose saved default is a managed cluster
  // it sent the workspace somewhere that bills -- with no warning, because this note
  // keyed on an EXPLICIT choice. The default option was the one path with nothing
  // said about it.
  const chosen = csel.value
    ? KUBE_CLUSTERS.find((c) => c.context === csel.value)
    : KUBE_CLUSTERS.find((c) => c.is_default);
  if (!chosen || !chosen.billable || (row && row.hidden)) { note.hidden = true; return; }
  const domain = ctx.$("#create-form").domain;
  const hasDomain = !!(domain && domain.value.trim());
  note.hidden = false;
  note.innerHTML = "";
  note.append(ctx.el("b", {}, csel.value ? "This cluster costs money. "
                                    : `Without a choice this goes to ${chosen.context}, which costs money. `));
  note.append("A workspace on it adds an EBS volume, and a public name adds a load "
    + "balancer. Deleting the workspace does not delete the cluster.");
  if (!hasDomain) {
    note.append(ctx.el("br", {}));
    note.append("Without a domain it is reachable only by a port-forward from the "
      + "server — tied to a pod, gone when it restarts, one person at a time. ");
    note.append(ctx.el("button", { type: "button", class: "btn small",
      onclick: () => {
        // No longer opens Advanced: the HTTPS block moved into section 2, where the
        // cluster it depends on is chosen. Opening a disclosure that no longer holds
        // the field would scroll past it.
        const mode = ctx.$("#https-mode");
        if (mode && [...mode.options].some((o) => o.value === "acme")) {
          mode.value = "acme";
          syncHttpsFields();
        }
        const d = ctx.$("#create-form").domain;
        if (d) { d.scrollIntoView({ block: "center" }); d.focus(); }
      } }, "Set a domain"));
  }
}

function syncAdvancedForRuntime(spec) {
  const gone = new Set(((spec && spec.unsupported) || []).map((u) => u.field));

  // HTTPS is a block of its own, so it goes entirely -- but only when HTTPS itself
  // is refused. This used to read `gone.has("https") || gone.has("domain")`, which
  // was right while a runtime refused both and became wrong the moment one of them
  // worked: Kubernetes now serves `--https` through the chart's own Ingress and still
  // cannot do `--domain`, and the || hid the whole control for want of the half that
  // is missing.
  const https = ctx.$("#create-https-block");
  if (https) https.hidden = gone.has("https");

  // WHICH cluster is a Kubernetes question and means nothing on Compose, so the row
  // is absent rather than disabled -- this dialog's rule, and the same one
  // `#replicas-row` follows for a field that is meaningless on a monolith.
  // BOTH rules, in ONE place, because this row is the first field to be governed by
  // two of them: it is PRIVILEGED (the box policy may forbid it) and it is
  // KUBERNETES-ONLY (it means nothing on Compose). The privileged loop in openCreate
  // deliberately skips it -- that loop runs later and would re-show a row this line
  // had just hidden for the runtime, offering a cluster picker on Docker.
  const ctxRow = ctx.$("#context-row");
  if (ctxRow) {
    ctxRow.hidden = !ctx.MAY_SET_PRIVILEGED || !spec || spec.name !== "kubernetes";
    const hint = ctx.$("#context-hint");
    if (hint) hint.hidden = ctxRow.hidden;
    if (ctxRow.hidden) { const cs = ctx.$("#context-select"); if (cs) cs.value = ""; }
    syncClusterNote();
  }

  // The MODE is the thing that is unavailable, so the mode goes and the block stays.
  // Removed rather than disabled, because that is this dialog's rule -- a disabled
  // option invites a click and explains nothing, and `#adv-gone` below already says
  // what was taken away and why.
  const mode = ctx.$("#https-mode");
  if (mode) {
    const has = [...mode.options].some((o) => o.value === "acme");
    if (gone.has("domain") && has) {
      if (mode.value === "acme") mode.value = "";
      [...mode.options].find((o) => o.value === "acme").remove();
      syncHttpsFields();
    } else if (!gone.has("domain") && !has) {
      mode.append(ctx.el("option", { value: "acme" },
        "Let's Encrypt — a domain that already points here"));
    }
    syncLocalCaOption();
  }

  // `fresh` is ONE OPTION of the existing-name select, not the whole control:
  // `reuse` and `force` work on both runtimes, and hiding the row would take a
  // working choice away to remove a broken one. The option is removed and put back
  // rather than disabled, for the same reason the privileged fields are hidden.
  const existing = ctx.$("#create-form").existing;
  if (existing) {
    const has = [...existing.options].some((o) => o.value === "fresh");
    if (gone.has("fresh") && has) {
      if (existing.value === "fresh") existing.value = "reuse";
      [...existing.options].find((o) => o.value === "fresh").remove();
    } else if (!gone.has("fresh") && !has) {
      existing.append(ctx.el("option", { value: "fresh" },
        "Rebuild it and DELETE its data — users, channels, messages, uploads"));
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

function renderPresetParams() {
  const p = ctx.PRESETS.find((x) => x.name === ctx.$("#preset-select").value);
  ctx.$("#preset-desc").textContent = p ? p.description : "";
  const box = ctx.$("#preset-params"); box.innerHTML = "";
  for (const [key, help] of Object.entries((p && p.params_help) || {})) {
    box.append(ctx.el("label", {}, `--set ${key}`, ctx.el("input", { name: "set:" + key, placeholder: help })));
  }
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
  if (!val("domain")) { ctx.toast("HTTPS: a domain is required for Let's Encrypt"); return false; }
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
    preset: f.preset.value,
    port: f.port.value ? parseInt(f.port.value, 10) : 0,
    monitor: f.monitor.checked, seed: f.seed.checked, wait: f.wait.checked,
    // Always sent, both of them. Omitting `runtime` would let the service layer's
    // default decide, which is the same answer today and would silently stop being
    // so the moment that default moved -- and the dialog would still be showing the
    // old one.
    runtime: f.runtime ? f.runtime.value : "docker",
    deployment: f.deployment ? f.deployment.value : "",
    params: {},
  };
  if (f.replicas && !ctx.$("#replicas-row").hidden && f.replicas.value) {
    req.replicas = parseInt(f.replicas.value, 10);
  }
  if (f.mongo_operator && f.mongo_operator.checked) req.mongo_operator = true;
  if (f.seed.checked && f.seed_profile) req.seed_profile = f.seed_profile.value;
  if (!req.version) { ctx.toast("version is required"); return; }
  for (const inp of f.querySelectorAll("input[name^='set:']")) {
    if (inp.value.trim()) req.params[inp.name.slice(4)] = inp.value.trim();
  }
  for (const k of ["name", "reg_token", "mongo", "rc_image", "bind", "root_url"]) {
    if (f[k] && f[k].value.trim()) req[k] = f[k].value.trim();
  }
  for (const k of ["pin", "offline", "no_pull"]) if (f[k] && f[k].checked) req[k] = true;
  if (!applyHttpsToRequest(f, req)) return;      // validates before closing the dialog
  // One choice, not two checkboxes: either flag bypasses reuse, and `fresh` already
  // implies `force`, so ticking both was meaningless.
  const existing = f.existing ? f.existing.value : "reuse";
  if (existing === "force") req.force = true;
  if (existing === "fresh") {
    if (!confirm(`This DELETES ${req.name || "the existing repro"}'s data volume — all users, `
      + `channels, messages and uploads — then rebuilds it.\n\nContinue?`)) return;
    req.fresh = true;
  }
  ctx.$("#create-dialog").close();
  try { const { job_id } = await ctx.api("/api/repros", { method: "POST", body: JSON.stringify(req) }); ctx.streamJob(job_id, `Creating ${req.version} (${req.preset})`, ctx.renderCreateResult); }
  catch (e) { ctx.toast(e.message); }
}


Object.defineProperties(ctx, {
  "RUNTIMES": { enumerable: true, get: () => RUNTIMES, set: value => { RUNTIMES = value; } },
  "RUNTIME_LABEL": { enumerable: true, get: () => RUNTIME_LABEL },
  "runtimeLabel": { enumerable: true, get: () => runtimeLabel },
  "DEPLOYMENT_LABEL": { enumerable: true, get: () => DEPLOYMENT_LABEL },
  "DEPLOYMENT_NOTE": { enumerable: true, get: () => DEPLOYMENT_NOTE },
  "RUNTIME_PITCH": { enumerable: true, get: () => RUNTIME_PITCH },
  "fmtGb": { enumerable: true, get: () => fmtGb },
  "renderRuntimeAxes": { enumerable: true, get: () => renderRuntimeAxes },
  "pickRuntime": { enumerable: true, get: () => pickRuntime },
  "pickDeployment": { enumerable: true, get: () => pickDeployment },
  "ADV_GONE_LABEL": { enumerable: true, get: () => ADV_GONE_LABEL },
  "KUBE_CLUSTERS": { enumerable: true, get: () => KUBE_CLUSTERS, set: value => { KUBE_CLUSTERS = value; } },
  "MACHINE_ROOM": { enumerable: true, get: () => MACHINE_ROOM, set: value => { MACHINE_ROOM = value; } },
  "clusterLabel": { enumerable: true, get: () => clusterLabel },
  "runsOnThisMachine": { enumerable: true, get: () => runsOnThisMachine },
  "syncRoomLine": { enumerable: true, get: () => syncRoomLine },
  "syncLocalCaOption": { enumerable: true, get: () => syncLocalCaOption },
  "syncClusterNote": { enumerable: true, get: () => syncClusterNote },
  "syncAdvancedForRuntime": { enumerable: true, get: () => syncAdvancedForRuntime },
  "syncDeploymentFields": { enumerable: true, get: () => syncDeploymentFields },
  "renderPresetParams": { enumerable: true, get: () => renderPresetParams },
  "TLS_LABEL": { enumerable: true, get: () => TLS_LABEL },
  "doTlsStatus": { enumerable: true, get: () => doTlsStatus },
  "HTTPS_MODE_HINT": { enumerable: true, get: () => HTTPS_MODE_HINT },
  "syncHttpsFields": { enumerable: true, get: () => syncHttpsFields },
  "applyHttpsToRequest": { enumerable: true, get: () => applyHttpsToRequest },
  "submitCreate": { enumerable: true, get: () => submitCreate },
});
export { RUNTIMES, RUNTIME_LABEL, runtimeLabel, DEPLOYMENT_LABEL, DEPLOYMENT_NOTE, RUNTIME_PITCH, fmtGb, renderRuntimeAxes, pickRuntime, pickDeployment, ADV_GONE_LABEL, KUBE_CLUSTERS, MACHINE_ROOM, clusterLabel, runsOnThisMachine, syncRoomLine, syncLocalCaOption, syncClusterNote, syncAdvancedForRuntime, syncDeploymentFields, renderPresetParams, TLS_LABEL, doTlsStatus, HTTPS_MODE_HINT, syncHttpsFields, applyHttpsToRequest, submitCreate };
