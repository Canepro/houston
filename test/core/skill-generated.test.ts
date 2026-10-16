/**
 * The shipped skill file is what the build would generate now, not a hand-edited copy.
 *
 * The file once said exit code 6 was reserved while three places raised it, because a
 * person restated the contract in prose. `tools/skill-generate.js` renders the
 * contract-bearing parts from `capabilities()` and keeps the prose in a template; this
 * holds data/skill/SKILL.md, and the two project copies an agent reads
 * inside the checkout, to a fresh render. A contract change without `node
 * tools/skill-generate.js` fails here, which is the point.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as config from '../../src/lib/config';

import { capabilities } from '../../src/cli/capabilities';

const ROOT = path.resolve(__dirname, '..', '..');
const generator = require(path.join(ROOT, 'tools', 'skill-generate.js')) as {
  TARGET: string;
  TEMPLATE: string;
  PROJECT_COPIES: string[];
  render: (manifest: unknown, template: string, version: string) => string;
};
const VERSION = (require('../../package.json') as { version: string }).version;

describe('the shipped skill file', () => {
  it('skill file matches capabilities', () => {
    const fresh = generator.render(
      capabilities(),
      fs.readFileSync(generator.TEMPLATE, 'utf8'),
      VERSION,
    );
    expect(fs.readFileSync(generator.TARGET, 'utf8')).toBe(fresh);
  });

  it('names the safe cluster read, and keep and share among what to ask about first', () => {
    // An agent was told to ask before `cluster create` and `cluster delete`, but not before
    // `keep` (it moves a cluster's deletion date) or `share` (it grants AWS access), and
    // was never told which cluster command only reads.
    const shipped = fs.readFileSync(generator.TARGET, 'utf8');
    expect(shipped).toMatch(/`houston cluster overview --json`[ \t]+\|[ \t]+the safe read/u);
    const ask = shipped.slice(
      shipped.indexOf('### Ask a person first'),
      shipped.indexOf('## Three standing rules'),
    );
    expect({
      keep: ask.includes('`cluster keep`'),
      share: ask.includes('`cluster share`'),
    }).toEqual({
      keep: true,
      share: true,
    });
  });

  it('never tells an agent to attach the admin password', () => {
    // `info --json` carries `data.login.password` (the 1.x payload, which the skill itself
    // reads to tell the person how to log in), generated for any workspace reachable beyond
    // loopback. The skill called that whole record "the record to attach".
    const shipped = fs.readFileSync(generator.TARGET, 'utf8');
    const collect = shipped.slice(
      shipped.indexOf('### Collect what a case needs'),
      shipped.indexOf('### Tear it down'),
    );
    expect(collect).toContain('the record to attach');
    expect(collect).toContain("jq 'del(.data.login.password)'");
  });

  it('is what the two project copies hold, byte for byte', () => {
    const shipped = fs.readFileSync(generator.TARGET, 'utf8');
    for (const copy of generator.PROJECT_COPIES) {
      expect({
        copy: path.relative(ROOT, copy),
        same: fs.readFileSync(copy, 'utf8') === shipped,
      }).toEqual({
        copy: path.relative(ROOT, copy),
        same: true,
      });
    }
  });

  it('refuses to render an exit code it has no prose for, and prose for a code the build lacks', () => {
    const manifest = capabilities() as { exit_codes: Record<string, string> };
    const template = fs.readFileSync(generator.TEMPLATE, 'utf8');
    const extra = { ...manifest, exit_codes: { ...manifest.exit_codes, '9': 'teapot' } };
    expect(() => generator.render(extra, template, VERSION)).toThrow(/teapot.*no prose/u);
    const fewer = {
      ...manifest,
      exit_codes: Object.fromEntries(
        Object.entries(manifest.exit_codes).filter(([, n]) => n !== 'gate'),
      ),
    };
    expect(() => generator.render(fewer, template, VERSION)).toThrow(/names gate/u);
  });
});

it('generates only bundled presets even when the caller home adds or overrides presets', () => {
  const dir = path.join(config.home(), 'presets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hostile-custom.yaml'), 'name: hostile-custom\nenv: {}\n');
  fs.writeFileSync(path.join(dir, 'email.yaml'), 'name: renamed-email\nenv: {}\n');
  const script = "const g = require('./tools/skill-generate'); process.stdout.write(g.generate());";
  const generated = execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HOUSTON_HOME: config.home() },
  });
  expect(generated).not.toContain('`hostile-custom`');
  expect(generated).not.toContain('`renamed-email`');
  expect(generated).toBe(fs.readFileSync(generator.TARGET, 'utf8'));
});
