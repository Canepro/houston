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
