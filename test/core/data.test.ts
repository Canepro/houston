import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as DataNS from '../../src/core/data';
import { metadata, writeRecord } from '../../src/core/runner/record';
import type * as ErrorsMod from '../../src/lib/errors';

const ROOT = path.resolve(__dirname, '..', '..');

describe('reading a scaleseed result out of mongosh output', () => {});

describe('the config-import plan summary', () => {
  it('shows a float the dump wrote as a float, nested or not, as earlier releases do', async () => {
    // A float keeps its point and its sign: `5.0`, `-0.0`, `1e+16`, `[1.0, None]`. The plan
    // once printed `5`, `0`, `10000000000000000` and `[1, None]`. The expected list is the
    // one earlier releases produced for this dump, recorded.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-data-floats-'));
    const dump = path.join(dir, 'settings.json');
    fs.writeFileSync(
      dump,
      '[{"_id": "A_whole", "value": 5.0, "packageValue": 1},' +
        ' {"_id": "A_neg0", "value": -0.0, "packageValue": 1},' +
        ' {"_id": "A_16", "value": 1e16, "packageValue": 1},' +
        ' {"_id": "C_float_e15", "value": 1000000000000000.0, "packageValue": 1},' +
        ' {"_id": "A_big", "value": 12345678901234567890, "packageValue": 1},' +
        ' {"_id": "A_nested", "value": {"b": [1.0, null], "2": 3.0}, "packageValue": {}}]',
      'utf8',
    );
    try {
      await writeRecord('d', metadata({ name: 'd', project: 'houston-d' }));
      const expected = [
        { id: 'A_whole', value: '5.0' },
        { id: 'A_neg0', value: '-0.0' },
        { id: 'A_16', value: '1e+16' },
        { id: 'C_float_e15', value: '1000000000000000.0' },
        { id: 'A_big', value: '12345678901234567890' },
        { id: 'A_nested', value: '{"b": [1.0, null], "2": 3.0}' },
      ];
      const { importPlan } = require('../../src/core/data') as typeof DataNS;
      expect((await importPlan('d', dump)).apply).toEqual(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a malformed dump but lets a missing file speak for itself', async () => {
    await writeRecord('d', metadata({ name: 'd', project: 'houston-d' }));
    const { importPlan, buildThePlan } = require('../../src/core/data') as typeof DataNS;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-data-bad-'));
    const bad = path.join(dir, 'settings.json');
    fs.writeFileSync(bad, '{"not": "a list"}', 'utf8');
    const malformed = path.join(dir, 'malformed.json');
    fs.writeFileSync(malformed, '[{', 'utf8');
    try {
      await expect(importPlan('d', bad)).rejects.toThrow("couldn't read settings file");
      await expect(importPlan('d', malformed)).rejects.toThrow("couldn't read settings file");
      // A missing path is not a malformed dump: the plan does NOT catch it, and the
      // filesystem's own error propagates.
      expect(() => buildThePlan(path.join(dir, 'absent.json'), null)).toThrow(
        /ENOENT|no such file/iu,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a --scale request', () => {
  it('refuses a spec it cannot parse, and one with nothing to do, as validation errors', async () => {
    const { runScaleLocked } = require('../../src/core/data') as typeof DataNS;
    const { ValidationError } = require('../../src/lib/errors') as typeof ErrorsMod;
    await expect(runScaleLocked('x', 'garbage-spec')).rejects.toBeInstanceOf(ValidationError);
    await expect(runScaleLocked('x', '')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('the package data this build reads', () => {
  it('is tracked by git, every file of it, so a clone has it too', () => {
    // Present on this machine is not the same as shipped: an unanchored `docs/` in
    // .gitignore once excluded the package's `data/docs/` from every clone while every test,
    // running against the working tree, passed. Only git knows what a clone gets.
    const data = path.join(ROOT, 'data');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files.push(path.relative(ROOT, full));
      }
    };
    walk(data);
    expect(files.length).toBeGreaterThan(0);
    const listed = spawnSync('git', ['ls-files', '-z', '--', 'data'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(listed.status).toBe(0);
    const tracked = new Set(listed.stdout.split('\0').filter((one) => one !== ''));
    expect(files.filter((one) => !tracked.has(one)).sort()).toEqual([]);
  });
});
