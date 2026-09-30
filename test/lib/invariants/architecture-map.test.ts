/**
 * The shipped architecture document names every production module, so a reader arriving at
 * this tree gets the whole map. Earlier releases had the same guard over their own map
 * (a walk of every module against ARCHITECTURE.md), and it went off three times: the cloud path shipped without `eks` or `cluster` in the map, and
 * `migrate` was missing for as long as the guard read another file. With the document
 * redrawn for src/, the guard lives here: a module added without a row in
 * data/docs/ARCHITECTURE.md fails the suite.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GUIDE = path.join(ROOT, 'data', 'docs', 'ARCHITECTURE.md');
function productionModules(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productionModules(full, out);
    else if (entry.name.endsWith('.ts')) {
      out.push(path.relative(path.join(ROOT, 'src'), full).split(path.sep).join('/'));
    }
  }
  return out;
}

describe('the shipped architecture map', () => {
  it('names every production module under src/', () => {
    const text = fs.readFileSync(GUIDE, 'utf8');
    const modules = productionModules(path.join(ROOT, 'src'), []).sort();
    expect(modules.length).toBeGreaterThan(150);
    // A module is named the way a reader would say it: any suffix of its path under src/
    // (`web/routes/logs.ts`, `routes/logs.ts`, `logs.ts`), with or without the extension, in
    // backticks. Pinning one spelling would make this a formatting rule, not a coverage one.
    const missing = modules.filter((rel) => {
      const parts = rel.split('/');
      const suffixes = parts.map((_, index) => parts.slice(index).join('/'));
      const forms = suffixes.flatMap((form) => [form, form.replace(/\.ts$/u, '')]);
      return !forms.some((form) => text.includes(`\`${form}\``));
    });
    expect(missing).toEqual([]);
  });

  it('ships as package data, tracked by git', () => {
    expect(fs.existsSync(GUIDE)).toBe(true);
    const listed = spawnSync('git', ['ls-files', '--', 'data/docs/ARCHITECTURE.md'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(listed.stdout.trim()).toBe('data/docs/ARCHITECTURE.md');
  });
});
