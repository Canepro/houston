/**
 * Whether a journal note's owner is still running, on a Mac, where there is no /proc.
 *
 * `procStarted` read /proc/<pid>/stat and answered null -- "not running" -- for every pid on
 * a Mac, this process's own included. Every note was then abandoned: a CLI cluster build in
 * another terminal read as "failed part-way", and `serve`'s startup recovery would undo work
 * still in progress. Here /proc is absent and the platform is darwin.
 */
import { spawnSync } from 'node:child_process';
import type * as FsNS from 'node:fs';

import type * as JournalNS from '../../src/core/journal';

jest.mock('node:fs', () => {
  const real = jest.requireActual<typeof FsNS>('node:fs');
  return {
    ...real,
    readFileSync: (file: never, ...rest: never[]) => {
      if (String(file).startsWith('/proc/')) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, '${String(file)}'`), {
          code: 'ENOENT',
        });
      }
      return real.readFileSync(file, ...rest);
    },
  };
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
});

/** A pid that has run and exited. */
function goneAway(): number {
  return spawnSync('true').pid;
}

describe('a journal note on a Mac', () => {
  it('belongs to a running process while that process runs', () => {
    const journal = require('../../src/core/journal') as typeof JournalNS;
    expect(journal.procStarted(process.pid)).toBe('');
    // pid 1 is not ours to signal: refused, which still means it is running.
    expect(journal.procStarted(1)).toBe('');
    expect(journal.procStarted(goneAway())).toBeNull();
    // A pid that parsed to 0 is not this process's group.
    expect(journal.procStarted(0)).toBeNull();

    // A cluster build this process is running is building, not "failed part-way".
    const id = journal.record(journal.CLUSTER_UNFINISHED, 'support', { region: 'us-east-1' });
    expect(id).not.toBe('');
    expect(journal.abandoned().map((entry) => entry.id)).not.toContain(id);
  });

  it('is abandoned once its process is gone', () => {
    const journal = require('../../src/core/journal') as typeof JournalNS;
    const id = journal.record(journal.CLUSTER_UNFINISHED, 'support', { region: 'us-east-1' });
    const entry = journal.openEntries().find((open) => open.id === id) as JournalNS.Entry;
    expect(journal.ownerAlive({ ...entry, pid: goneAway() })).toBe(false);
  });
});
