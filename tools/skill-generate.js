#!/usr/bin/env node
/**
 * `node tools/skill-generate.js [--check]` -- write data/skill/SKILL.md (and the two project
 * copies) from tools/skill/SKILL.template.md and the build's own `capabilities`.
 *
 * WHY. The skill file is prose an agent reads before driving this tool, and prose goes
 * stale: it once said exit code 6 was reserved "which nothing in this build raises" while
 * three places raised it. So the parts of it that restate the contract -- the exit-code
 * table, the preset names, which commands stream and which answer `--json`, the version in
 * the envelope example -- are RENDERED from `capabilities()`, the same manifest the command
 * prints, and only the prose lives in the template. `test/core/skill-generated.test.ts` holds
 * the shipped file to a fresh render, so a build that changes the contract without
 * regenerating fails the suite. The prose that explains each exit code lives HERE, keyed by
 * the code's name: a code the build adds without a line, or a line for a code the build no
 * longer has, refuses to render.
 *
 * `--check` renders and compares, writing nothing; without it the three copies are written.
 * The version comes from package.json, not from the manifest: in-process the manifest's
 * version is the registry's placeholder until the front door sets it.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'tools', 'skill', 'SKILL.template.md');
const TARGET = path.join(ROOT, 'data', 'skill', 'SKILL.md');
/** The project copies a checkout carries so an agent working in it reads the same file. */
const PROJECT_COPIES = [
  path.join(ROOT, '.claude', 'skills', 'houston', 'SKILL.md'),
  path.join(ROOT, '.agents', 'skills', 'houston', 'SKILL.md'),
];

/** What each non-zero exit code means to a caller, keyed by the name `capabilities` gives it. */
const EXIT_PROSE = {
  internal:
    'an unhandled failure. There is still an envelope on stdout;\n' +
    '     the stack trace is on stderr. Retrying unchanged will not help.',
  usage: 'fix the call; retrying unchanged will not help.',
  preflight: 'the environment is not usable. Run `houston doctor --json`.',
  not_found: 'no such workspace.',
  not_ready:
    'from `ready` or `up --wait`, it is still starting: poll again.\n' +
    '     From `down --volumes`, it is still there: read the warning, do not retry.',
  gate:
    'an action needs a human decision houston is not authorised to make.\n' +
    '     Never retryable and never auto-approvable: `error.gate.approve_with` is what to ask a\n' +
    '     PERSON to run, not something you may run yourself.',
  create_failed: 'known dead. Stop; do not retry in a loop.',
  conflict: 'the name or port is taken. Pick another.',
};

function code(text) {
  return `\`${text}\``;
}

/** The manifest's `data` (the CLI wraps it in an envelope; in-process it is bare). */
function dataOf(manifest) {
  const data =
    manifest !== null && typeof manifest === 'object' && 'data' in manifest
      ? manifest.data
      : manifest;
  if (data === null || typeof data !== 'object')
    throw new Error('capabilities did not return a manifest');
  return data;
}

function renderExitCodes(exitCodes) {
  const lines = [];
  const seen = new Set();
  for (const [number, name] of Object.entries(exitCodes).sort(
    (a, b) => Number(a[0]) - Number(b[0]),
  )) {
    if (name === 'ok') continue;
    const prose = EXIT_PROSE[name];
    if (prose === undefined)
      throw new Error(`exit code ${number} (${name}) has no prose in EXIT_PROSE`);
    seen.add(name);
    lines.push(`   - ${code(number)} ${name.replaceAll('_', ' ')} — ${prose}`);
  }
  for (const name of Object.keys(EXIT_PROSE)) {
    if (!seen.has(name))
      throw new Error(`EXIT_PROSE names ${name}, which is not an exit code of this build`);
  }
  return lines.join('\n');
}

/** A list in prose: `a`, `b` and `c`. */
function listed(names) {
  const quoted = names.map(code);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/** Render the template against a manifest; every placeholder must be consumed. */
function render(manifest, template, version) {
  const data = dataOf(manifest);
  const commands = Array.isArray(data.commands) ? data.commands : [];
  const values = {
    exit_codes: renderExitCodes(data.exit_codes ?? {}),
    // `multi-instance` is the deployment axis under its old preset name (the template's prose
    // says so), not a scenario an agent should pick from this list; skill.test.ts pins that.
    presets: (Array.isArray(data.presets) ? data.presets : [])
      .filter((name) => name !== 'multi-instance')
      .map(code)
      .join(', '),
    streams: listed(commands.filter((c) => c.streams).map((c) => c.name)),
    json_commands: commands
      .filter((c) => c.json)
      .map((c) => c.name)
      .map(code)
      .join(', '),
    houston_version: version,
  };
  const out = template.replaceAll(/\{\{([a-z_]+)\}\}/gu, (whole, key) => {
    if (!(key in values)) throw new Error(`the template names {{${key}}}, which nothing renders`);
    return values[key];
  });
  if (out.includes('{{')) throw new Error('a placeholder survived rendering');
  return out;
}

/** The shipped file as this build would write it now. */
function generate() {
  require(path.join(ROOT, 'tools', 'ts-require')).install();
  const { capabilities } = require(path.join(ROOT, 'src', 'cli', 'capabilities.ts'));
  const version = require(path.join(ROOT, 'package.json')).version;
  // A packaged skill describes bundled presets, never the caller's private catalogue.
  const previous = process.env.HOUSTON_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-skill-generate-'));
  try {
    process.env.HOUSTON_HOME = home;
    return render(capabilities(), fs.readFileSync(TEMPLATE, 'utf8'), version);
  } finally {
    if (previous === undefined) delete process.env.HOUSTON_HOME;
    else process.env.HOUSTON_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const fresh = generate();
  const check = process.argv.includes('--check');
  const targets = [TARGET, ...PROJECT_COPIES];
  if (check) {
    const stale = targets.filter(
      (file) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== fresh,
    );
    if (stale.length > 0) {
      process.stderr.write(
        `skill-generate: stale: ${stale.map((f) => path.relative(ROOT, f)).join(', ')}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`skill-generate: ${String(targets.length)} copies match the build\n`);
    }
  } else {
    for (const file of targets) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, fresh, 'utf8');
    }
    process.stdout.write(
      `skill-generate: wrote ${targets.map((f) => path.relative(ROOT, f)).join(', ')}\n`,
    );
  }
}

module.exports = { EXIT_PROSE, PROJECT_COPIES, TARGET, TEMPLATE, generate, render };
