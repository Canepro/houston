/**
 * INVARIANT: the durable sinks record what they must and reach for nothing.
 *
 * MECHANISM: BEHAVIOURAL.
 *
 * Earlier releases held every one of these with a source read beside a behavioural assertion:
 * a phrase that must appear in one function's text, a list of names that must not, a word that
 * must be absent from a module, a statement found by its offset and the text that follows it.
 * Each is a claim about what a call DOES, so each is made by making the call.
 */
import type * as nodeFsNS from 'node:fs';

import type * as EventlogNS from '../../../src/core/eventlog';
import type * as JournalNS from '../../../src/core/journal';
import type * as RecoveryNS from '../../../src/core/recovery';
import type * as ScaleseedNS from '../../../src/core/scaleseed';

import { event } from '../../../src/lib/events';

afterEach(() => {
  jest.resetModules();
});

describe('the event log', () => {
  it('keeps docker’s echo out and a warning in', () => {
    const eventlog = require('../../../src/core/eventlog') as typeof EventlogNS;
    const fs = require('node:fs') as typeof nodeFsNS;
    eventlog.resetForTest();
    eventlog.event(event('Downloading 45.09MB', { phase: 'boot', data: { echo: 'docker' } }));
    eventlog.event(event('resolved 8.5.1', { phase: 'create' }));
    eventlog.event(
      event('pull failed: rate limit', { phase: 'boot', level: 'warn', data: { echo: 'docker' } }),
    );
    const written = fs.readFileSync(eventlog.logPath(), 'utf8');

    // `_up` turns every line of `docker compose pull` into an event, so a GUI create emits
    // several hundred `Downloading …` records. That is echo, not narrative: logging it
    // buries the four lines that matter and spends the whole size cap on one create.
    expect(written).not.toContain('Downloading 45.09MB');
    expect(written).toContain('resolved 8.5.1');
    // A WARNING IS NEVER SKIPPED, echo or not. This is the half that made earlier releases'
    // guard worth having: a warning carrying the echo tag was being dropped with it.
    expect(written).toContain('rate limit');

    // And opting back in keeps it, for somebody debugging a pull.
    process.env.HOUSTON_LOG_ECHO = '1';
    try {
      eventlog.event(event('Downloading 99MB', { phase: 'boot', data: { echo: 'docker' } }));
      expect(fs.readFileSync(eventlog.logPath(), 'utf8')).toContain('Downloading 99MB');
    } finally {
      delete process.env.HOUSTON_LOG_ECHO;
    }
  });
});

describe('journal.describe', () => {
  it('describes without doing anything', () => {
    const touched: string[] = [];
    jest.resetModules();
    // EVERY SEAM A REPAIR WOULD REACH FOR, watched. `describe()` is a FORMATTING function
    // and `houston doctor` renders it in a report; one that restored a setting, removed a
    // note or shelled out would do all of that from a read-only command.
    jest.doMock('../../../src/core/runner/record', () => ({
      ...(jest.requireActual('../../../src/core/runner/record') as Record<string, unknown>),
      readMeta: () => {
        // RECORDED, not thrown. A throw here escapes `describe` and crashes the run
        // before the assertion below can name what happened.
        touched.push('record.readMeta');
        return {};
      },
      write: async () => {
        touched.push('record.write');
      },
    }));
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...(jest.requireActual('../../../src/core/runner/engine') as Record<string, unknown>),
      composeExecCapture: async () => {
        touched.push('engine.composeExecCapture');
        return [0, ''];
      },
      startServices: async () => {
        touched.push('engine.startServices');
        return 0;
      },
    }));
    try {
      const journal = require('../../../src/core/journal') as typeof JournalNS;
      expect(journal.KINDS.length).toBeGreaterThan(5);
      for (const kind of journal.KINDS) {
        const text = journal.describe({
          id: 'i',
          kind,
          workspace: 'w',
          pid: 1,
          started: '0',
          at: 'T',
          detail: { bundle: '/b/x.rcbak' },
        } as JournalNS.Entry);
        expect(typeof text).toBe('string');
        expect(`${kind}: names the workspace`).toBe(
          text.includes('w') ? `${kind}: names the workspace` : `${kind}: DOES NOT name it`,
        );
      }
    } finally {
      jest.dontMock('../../../src/core/runner/record');
      jest.dontMock('../../../src/core/runner/engine');
      jest.resetModules();
    }
    expect(touched).toEqual([]);
  });
});

describe('the recovery registry', () => {
  it('registers a repair for every kind that has one', () => {
    const journal = require('../../../src/core/journal') as typeof JournalNS;
    const recovery = require('../../../src/core/recovery') as typeof RecoveryNS;
    recovery.install();
    const repairable = journal.KINDS.filter((kind) => !journal.ADVISORY.includes(kind));
    const registered = new Set(journal.repairKinds());
    // `journal` is BELOW the modules that own these side effects, so it cannot import them.
    // The handlers register INTO it instead, which is the dependency inversion -- and a
    // registry nobody fills is a recovery that silently repairs nothing.
    expect(repairable.length).toBeGreaterThan(3);
    expect(repairable.filter((kind) => !registered.has(kind))).toEqual([]);
  });
});

describe('the bulk seed and the profiler', () => {
  it('read the workspace’s own database rather than a hardcoded one', async () => {
    // THROUGH THE MODULE REGISTRY: an emitted export is a getter, so `jest.spyOn` on it
    // raises `Cannot redefine property`. This is the same reason every seam swap in these
    // specs goes through `doMock` and a fresh `require`.
    jest.resetModules();
    jest.doMock('../../../src/core/database-of', () => ({
      ...(jest.requireActual('../../../src/core/database-of') as Record<string, unknown>),
      databaseOf: async () => 'somewhere-else',
    }));
    try {
      const scaleseed = require('../../../src/core/scaleseed') as typeof ScaleseedNS;
      // Both hardcoded `DB = "rocketchat"` and a localhost URI built from it, so a
      // workspace whose MONGO_URL names another database was scaled into the wrong one.
      expect(await scaleseed.dbOf('w')).toBe('somewhere-else');
    } finally {
      jest.dontMock('../../../src/core/database-of');
      jest.resetModules();
    }
    jest.doMock('../../../src/core/database-of', () => ({
      ...(jest.requireActual('../../../src/core/database-of') as Record<string, unknown>),
      databaseOf: async () => '',
    }));
    try {
      const scaleseed = require('../../../src/core/scaleseed') as typeof ScaleseedNS;
      // The fallback is still the default, so a workspace whose compose cannot be read
      // behaves exactly as before rather than failing.
      expect(await scaleseed.dbOf('no-such-workspace')).toBe(scaleseed.DB);
    } finally {
      jest.dontMock('../../../src/core/database-of');
      jest.resetModules();
    }
  });

  it('removes what an older houston seeded as well as its own', async () => {
    const sent: string[] = [];
    jest.resetModules();
    // THE MONGO SEAM. The script is built inside `clear` and handed to the workspace's own
    // mongosh; recording it here is the only place it exists as a value, and it is the
    // value that decides what gets deleted.
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...(jest.requireActual('../../../src/core/runner/engine') as Record<string, unknown>),
      composeExecCapture: async (_name: string, _service: string, argv: readonly string[]) => {
        sent.push(argv.join(' '));
        return [0, '{}'];
      },
    }));
    jest.doMock('../../../src/core/database-of', () => ({
      ...(jest.requireActual('../../../src/core/database-of') as Record<string, unknown>),
      databaseOf: async () => 'rocketchat',
    }));
    try {
      const scaleseed = require('../../../src/core/scaleseed') as typeof ScaleseedNS;
      await scaleseed.clear('w');
    } catch {
      // The eval cannot land here; the script it sent is the claim.
    } finally {
      jest.dontMock('../../../src/core/runner/engine');
      jest.dontMock('../../../src/core/database-of');
      jest.resetModules();
    }
    const js = sent.join('\n');
    // The tag is stamped into the WORKSPACE's own MongoDB, so it is the one leftover a
    // rename cannot reach by moving a directory. Clearing only the new tag would leave a
    // bulk seed permanently unremovable -- the one operation `--clear` exists to provide --
    // with no error to explain why nothing happened.
    expect(js).toContain('rcrepro_scale');
    expect(js).toContain('houston_scale');
    for (const statement of ["db['users'].deleteMany(", "db['rocketchat_message'].deleteMany("]) {
      const at = js.indexOf(statement);
      expect(`${statement} present`).toBe(
        at > -1 ? `${statement} present` : `${statement} MISSING`,
      );
      // EVERY destructive statement uses the combined match, not the bare new tag.
      expect(js.slice(at + statement.length).startsWith('{$or:')).toBe(true);
    }
  });
});
