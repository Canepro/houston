'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXPECTED = 'ec57264d55853cc5d0bc3803cfd75cf7c41d9c4ed336e2d739431ee4d780f2aa';
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
