'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXPECTED = '8139ae2bed742b622631707c76da3dd1ec3cc739f69f15d5a34187f6b5f13603';
// First recorded, when the GUI was frozen, from:
//   find houston/data/webui -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum
// Re-recorded once, deliberately, for six comment-only edits that name the TypeScript
// modules the comments describe; no rule, markup or script changed.
// Keep both the sorted relative names and sha256sum's two-space record separator. The
// explicit inventory also makes an addition, removal or rename fail before hashing.
//
// The assets have since moved, byte for byte, from `houston/data/webui` to `data/webui`.
// The manifest still names each file under the label that was hashed, so the digest stays comparable to that record -- the frozen
// claim is about the bytes, and a move is not a change to them.
// Re-recorded for the public Grafana attachment result: closing it refreshes the
// document's frame-src allow-list before a dashboard is embedded.
// Re-recorded for four cluster fixes: the create dialog sends the chosen cluster, the
// delete dialog sends the cluster's region, the cluster cards use a radius token that
// exists, and a detached job is watched until it ends rather than for 15 minutes.
// Re-recorded for the cluster card reading "houston's own" from the ledger's ownership
// tag rather than from the kind-cluster switch, which is never true for EKS.
// Re-recorded for the Clusters page rebuild: a stepper of the six stages, the next step
// from the core, a totals strip, one table row per cluster and the selected one's detail
// and actions, all rendered from /api/clusters/overview instead of a card per probe.
// Re-recorded for the Clusters card on Home and the chip naming what is billing, both from
// the same overview, read at most once every two minutes whoever asks.
// Re-recorded for the guided build flow: four steps replace the four-field dialog, each
// with its checks and the terminal command that does the same, and the DNS step opens by
// itself when a build ends.
// Re-recorded for section 2's cluster cards (one per cluster, with what it costs) over the
// hidden select that still carries the value, and a cluster pane opening a workspace on it.
// Re-recorded for a Kubernetes workspace naming its cluster, the certificate check on a
// cluster workspace with a public name, and cluster jobs saying their result in the log.
// Re-recorded for the delete's result separating what is tied to the cluster (with its
// command) from untagged candidates (to check, with none).
// Re-recorded for totals that say when they leave a cluster out: a "+" and "not priced"
// on the Clusters page, Home and the chip.
// Re-recorded for the review and screenshot fixes: the page and the build flow read the
// overview with no cluster yet, one read in flight, "?" not "free", an expired date in
// amber, the DNS stage passed over without a zone, commands kept whole, a stepper that
// fits, the identity on step 2, a costed "Decide for me", and Runs on on two lines.
// Re-recorded for a Cancel on every step of the build flow, and the delete dialog no
// longer telling you to release load balancers with a kubectl that names no context.
// Re-recorded for the Clusters page in three places (on this machine, elsewhere, in AWS),
// a local cluster's plain detail read when it is opened, Home counting it apart from AWS,
// and the footer saying kubectl has no current context instead of "not set up".
// Re-recorded for the detail placed after its section rather than inside it, where the
// section's own re-render wiped it on a box whose only cluster is local.
// Re-recorded for an AWS section with nothing in it drawing no strip of zeros and no
// empty table header, and the pane naming a local cluster with its place.
// Re-recorded after restoring the original shell, Home and workspace dialog while
// retaining the EKS connection controls and hiding non-EKS remote GUI contexts.
// Re-recorded for the 2026-10 redesign from the approved prototype: Home as a dashboard,
// Create a workspace in two steps with its progress, the Clusters page given to Amazon
// EKS with this machine on one card, a cluster's own view, and Set up Amazon EKS.
// Re-recorded for the owner's first look: light by default with dark only from the toggle,
// no Offline or Don't-pull boxes in Create, Build first in Set up Amazon EKS with the
// check listing what houston built, and Refresh reading the page on screen again.
// Re-recorded for the sign-in page on the light ground: ink labels, a muted (not dim)
// foot, a solid Sign in button, and banner text dark enough to read on its tint.
// Re-recorded for the softer light palette the owner chose (grey-white cards on a grey
// ground) and the signal colours a step darker so text keeps 5:1 on it.
// Re-recorded for "Create here" offered only where the Create dialog can go: under the
// admin create policy a member gets Docker and the server's default, not every cluster.
// Re-recorded for the server's default read as where an empty context lands: the saved
// default, else the cluster `up` picks (what kubectl points at), measured on a k3s box.
// Re-recorded for what a first EKS cluster taught on a real Cloudflare zone: one card for a
// cluster being built, builds read after a page load, reminders only once due, the DNS
// record offered from Home, the card and the cluster's page and laid out field by field,
// Create asking for an email rather than a domain on a zoned cluster, a workspace's header
// drawn before its own read, and one workspace-list read at a time. Then the review's
// three: a build hides only its own name in its own region, Create promises <name>.<zone>
// only where the server will make it, and "Off" comes back chosen after a zoned cluster.
const ASSET_ROOT = 'data/webui';
const RECORDED_LABEL = 'houston/data/webui';
const ASSETS = [
  'app.css',
  'index.html',
  'js/api.js',
  'js/boot.js',
  'js/clusters-tail.js',
  'js/clusters.js',
  'js/create.js',
  'js/detail.js',
  'js/jobs.js',
  'js/logs.js',
  'js/main.js',
  'js/people.js',
  'js/perf.js',
  'js/render.js',
  'js/shared.js',
  'js/state.js',
  'js/theme.js',
  'js/util.js',
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function walk(directory, root) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return walk(absolute, root);
      if (!entry.isFile()) {
        throw new Error(`GUI asset is not a regular file: ${path.relative(root, absolute)}`);
      }
      return [path.relative(root, absolute)];
    })
    .sort();
}

function verify(root = path.resolve(__dirname, '..')) {
  const assetRoot = path.join(root, ASSET_ROOT);
  const found = walk(assetRoot, assetRoot);
  if (JSON.stringify(found) !== JSON.stringify(ASSETS)) {
    throw new Error(
      `GUI asset set changed\nexpected: ${ASSETS.join(', ')}\nactual:   ${found.join(', ')}`,
    );
  }
  const manifest = ASSETS.map((asset) => {
    const digest = sha256(fs.readFileSync(path.join(assetRoot, asset)));
    return `${digest}  ${RECORDED_LABEL}/${asset}\n`;
  }).join('');
  const actual = sha256(manifest);
  if (actual !== EXPECTED) {
    throw new Error(`GUI asset hash changed: expected ${EXPECTED}, got ${actual}`);
  }
  return actual;
}

function proveMutationIsRejected(root) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-gui-hash-'));
  try {
    fs.cpSync(path.join(root, ASSET_ROOT), path.join(scratch, ASSET_ROOT), { recursive: true });
    fs.appendFileSync(path.join(scratch, ASSET_ROOT, 'js/main.js'), '\n// mutation proof\n');
    try {
      verify(scratch);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('GUI asset hash changed:')) {
        return error.message;
      }
      throw error;
    }
    throw new Error('GUI hash verifier accepted a modified asset');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function proveNonRegularIsRejected(root) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-gui-hash-link-'));
  try {
    fs.cpSync(path.join(root, ASSET_ROOT), path.join(scratch, ASSET_ROOT), { recursive: true });
    const target = path.join(scratch, ASSET_ROOT, 'js/main.js');
    const saved = path.join(scratch, 'main.js');
    fs.copyFileSync(target, saved);
    fs.unlinkSync(target);
    fs.symlinkSync(saved, target);
    try {
      verify(scratch);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('GUI asset is not a regular file:')) {
        return error.message;
      }
      throw error;
    }
    throw new Error('GUI hash verifier accepted a non-regular asset');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const actual = verify(root);
  const mutation = proveMutationIsRejected(root);
  const nonRegular = proveNonRegularIsRejected(root);
  process.stdout.write(
    `GUI asset hash: ${actual}\nMutation sensitivity: ${mutation}\nAsset-type sensitivity: ${nonRegular}\n`,
  );
}

module.exports = {
  ASSET_ROOT,
  ASSETS,
  EXPECTED,
  proveMutationIsRejected,
  proveNonRegularIsRejected,
  verify,
};
