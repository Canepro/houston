import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../../src/lib/config';
import { runWithContext } from '../../../src/lib/context';
import type * as ContextNS from '../../../src/lib/context';
import { ConflictError } from '../../../src/lib/errors';
import type * as ErrorsNS from '../../../src/lib/errors';
import type * as AppNS from '../../../src/cli/app';
import type * as HandlersNS from '../../../src/cli/handlers';
import type * as BackupNS from '../../../src/core/backup';
import { metadata, writeRecord } from '../../../src/core/runner/record';
import type * as UpgradeNS from '../../../src/core/upgrade';
import { add } from '../../../src/core/users';

import type * as CreateDockerNS from '../../../src/core/lifecycle/create-docker';
import {
  carryOwnership,
  mayChown,
  mayDestroy,
  maySetPrivilegedFields,
  ownerOf,
  setOwner,
} from '../../../src/core/lifecycle/ownership';
import type * as TypesNS from '../../../src/core/lifecycle/types';

/**
 * What earlier releases answered for the two hand-edited-extra cases below, recorded:
 * `handEditedExtra` is gate, handover, repro.json text and audit line per shape;
 * `keyOrderAndNumbers` is the repro.json text after each handover.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'core', 'lifecycle', 'ownership.json'),
    'utf8',
  ),
) as { handEditedExtra: unknown[]; keyOrderAndNumbers: string[] };

describe('the ownership gate', () => {
  it('answers the destructor policy the way earlier releases do', async () => {
    // The policy lives in config, so earlier releases were asked the same question over the
    // same isolated home. A refusal carries the owner's name; the message earlier releases
    // print is the contract a front end renders.
    await writeRecord(
      'owned',
      metadata({ name: 'owned', project: 'houston-owned', extra: { owner: 'alice' } }),
    );
    const pairs: [string, string][] = [
      ['owned', 'alice'],
      ['owned', 'bob'],
      ['owned', ''],
    ];
    // What earlier releases answered for each pair, recorded.
    const recorded = {
      destroy: [
        [
          [true, ''],
          [true, ''],
        ],
        [
          [
            false,
            'owned belongs to alice — ask alice, or an admin can force it. (alice or an admin can hand it over to bob for good: Hand over… in its panel, or `houston chown -n owned --to bob`.)',
          ],
          [
            false,
            'owned belongs to alice — only alice or an admin can hand it over. Taking ownership is what decides who may destroy a workspace, so it is gated the same way as `down --volumes`.',
          ],
        ],
        [
          [true, ''],
          [true, ''],
        ],
      ],
      privileged: [true, true],
    };
    const answers: unknown[] = [];
    for (const [name, actor] of pairs) {
      answers.push([[...(await mayDestroy(name, actor))], [...(await mayChown(name, actor))]]);
    }
    expect(answers).toEqual(recorded.destroy);
    expect(['', 'bob'].map(maySetPrivilegedFields)).toEqual(recorded.privileged);
  });

  it('opens both gates for a single-user box and for the anyone policy', async () => {
    config.updateConfig((cfg) => {
      cfg['gui.destroy_policy'] = 'anyone';
    });
    await writeRecord(
      'owned',
      metadata({ name: 'owned', project: 'houston-owned', extra: { owner: 'alice' } }),
    );
    // With no accounts on the box, a named actor is still bounded by the owner rule --
    // unless the box has explicitly said `anyone`.
    expect(await mayDestroy('owned', 'bob')).toEqual([true, '']);
    expect(await mayChown('owned', 'bob')).toEqual([true, '']);
    // An empty actor means there are no accounts to compare against: nothing to bound.
    expect(await mayDestroy('owned', '')).toEqual([true, '']);
    // The create policy is asymmetric on purpose: it defaults open and is not what the
    // `anyone` key controls.
    expect(maySetPrivilegedFields('bob')).toBe(true);
  });
});

// --- whose workspace it is, and who may take it -------------------------------------------

describe('the recorded owner', () => {
  const GOOD = 'correct-horse-battery';

  beforeEach(() => {
    fs.rmSync(path.join(config.home(), 'users'), { force: true });
    fs.rmSync(path.join(config.home(), 'repros'), { recursive: true, force: true });
    fs.rmSync(path.join(config.home(), 'config.yaml'), { force: true });
  });

  /** Just enough of a workspace for `readMeta` to find it, owned the way `up` records it. */
  async function workspace(name: string, owner = ''): Promise<void> {
    await writeRecord(
      name,
      metadata({
        name,
        project: `houston-${name}`,
        rcVersion: '8.5.1',
        mongoTag: '6.0',
        hostPort: 3000,
        preset: 'default',
        rootUrl: 'http://localhost:3000',
        extra: owner === '' ? {} : { created_by: owner },
      }),
    );
    fs.writeFileSync(
      path.join(config.home(), 'repros', name, 'docker-compose.yml'),
      'services: {}\n',
    );
  }

  it('is read from the record, and is empty for a pre-team or a missing workspace', async () => {
    await workspace('alice-rc8-5-1', 'alice');
    await workspace('rc8-5-1');
    expect(await ownerOf('alice-rc8-5-1')).toBe('alice');
    expect(await ownerOf('rc8-5-1')).toBe('');
    // A missing one must not raise.
    expect(await ownerOf('does-not-exist')).toBe('');
  });

  it('cannot be reassigned by a member who wants to destroy it', async () => {
    // The destroy gate reads the OWNER, and the write to it was ungated: refused a destroy,
    // a member could chown the workspace to themselves and destroy it on the next call.
    await add('alice', GOOD, 'member');
    await add('bob', GOOD, 'member');
    await workspace('alice-rc8-5-1', 'alice');
    expect((await mayDestroy('alice-rc8-5-1', 'bob'))[0]).toBe(false);
    await expect(setOwner('alice-rc8-5-1', 'bob', { by: 'bob' })).rejects.toThrow(ConflictError);
    await expect(setOwner('alice-rc8-5-1', 'bob', { by: 'bob' })).rejects.toThrow(
      /belongs to alice/u,
    );
    expect(await ownerOf('alice-rc8-5-1')).toBe('alice');
    expect((await mayDestroy('alice-rc8-5-1', 'bob'))[0]).toBe(false);
  });

  it('can still be handed over by the owner or an admin, and claimed when nobody owns it', async () => {
    // Handing a ticket on is the reason `chown` is a verb at all.
    await add('root', GOOD, 'admin');
    await add('alice', GOOD, 'member');
    await add('bob', GOOD, 'member');
    await workspace('alice-rc8-5-1', 'alice');
    expect((await setOwner('alice-rc8-5-1', 'bob', { by: 'alice' })).to).toBe('bob');
    expect((await setOwner('alice-rc8-5-1', 'alice', { by: 'root' })).to).toBe('alice');
    await workspace('rc8-5-1');
    expect((await setOwner('rc8-5-1', 'bob', { by: 'bob' })).to).toBe('bob');
  });

  it('refuses a new owner nobody can sign in as with the name quoted as earlier releases quote it', async () => {
    // This hard-coded single quotes: `--to "O'Brien"` printed `'o'brien'` where earlier
    // releases print `"o'brien"`, and a backslash went unescaped.
    await add('root', GOOD, 'admin');
    await workspace('rc8-5-1');
    const owners = ["O'Brien", 'a\\b', 'x"y', 'tab\there'];
    // What earlier releases refused each one with, recorded.
    const recorded: string[][] = [
      [
        'NotFoundError',
        'no account named "o\'brien" (People lists them; `houston users list` from a shell) — a workspace cannot be handed to somebody who cannot sign in',
      ],
      [
        'NotFoundError',
        "no account named 'a\\\\b' (People lists them; `houston users list` from a shell) — a workspace cannot be handed to somebody who cannot sign in",
      ],
      [
        'NotFoundError',
        "no account named 'x\"y' (People lists them; `houston users list` from a shell) — a workspace cannot be handed to somebody who cannot sign in",
      ],
      [
        'NotFoundError',
        "no account named 'tab\\there' (People lists them; `houston users list` from a shell) — a workspace cannot be handed to somebody who cannot sign in",
      ],
    ];
    const ours: unknown[] = [];
    for (const to of owners) {
      try {
        ours.push(['ok', await setOwner('rc8-5-1', to, { by: 'root' })]);
      } catch (error) {
        ours.push([(error as Error).name, (error as Error).message]);
      }
    }
    expect(ours).toEqual(recorded);
    expect(recorded[0]?.[1]).toMatch(/^no account named "o'brien" \(People lists them/u);
  });

  it('names who can act in a destroy refusal, not a chown the caller cannot run', async () => {
    await add('alice', GOOD, 'member');
    await add('bob', GOOD, 'member');
    await workspace('alice-rc8-5-1', 'alice');
    expect((await mayDestroy('alice-rc8-5-1', 'bob'))[1]).toContain(
      'alice or an admin can hand it over to bob for good: Hand over… in its panel',
    );
  });
});

describe('a hand-edited extra', () => {
  // `ownerOf` and `setOwner` read `extra` only when it is a plain object, compare and record
  // the RAW owner, and build the history as a copied list. An earlier version read `meta.extra`
  // unchecked and stringified the owner: a null crashed `chown`, a list lost the handover
  // while reporting it done, an int 123 let the actor "123" through the gate, and a history
  // that was not an array was dropped.
  const SHAPES: unknown[] = [
    null,
    ['a'],
    'x',
    { owner: 123 },
    { owner: '', created_by: 0 },
    { created_by: null },
    { owner: true },
    { owner: ['x'] },
    { owner: { a: 1 } },
    { owner: 'alice', owner_history: { k: 'v', j: 2 } },
    { owner: 'alice', owner_history: 'ab' },
    { owner: 'alice', owner_history: 5 },
  ];
  const RECORD = {
    name: 'alpha',
    project: 'houston-alpha',
    rc_version: '8.5.1',
    rc_image: 'rocketchat/rocket.chat:8.5.1',
    mongo_tag: '8.0',
    mongo_flavor: 'community',
    preset: '',
    root_url: 'http://localhost:3100',
    host_port: 3100,
    version_source: 'offline',
    pinned: false,
    created_at: '2026-09-25T10:00:00+00:00',
    public_url: '',
    admin_password: '',
  };

  beforeEach(() => {
    fs.rmSync(path.join(config.home(), 'users'), { force: true });
    fs.rmSync(path.join(config.home(), 'repros'), { recursive: true, force: true });
    fs.rmSync(path.join(config.home(), 'config.yaml'), { force: true });
  });

  /** A call's value, or the error it raised as [class, message] -- the recorded shape. */
  async function outcome(call: () => Promise<unknown>): Promise<unknown[]> {
    try {
      return ['ok', await call()];
    } catch (error) {
      return [(error as Error).constructor.name, (error as Error).message];
    }
  }

  it('is gated, handed over and recorded as earlier releases did it', async () => {
    // For each shape: the gate for the actors "123" and "bob", then a handover by nobody
    // (no accounts, so nothing to bound), then repro.json as written -- the TEXT, so key
    // order counts -- and the audit line. The one clock reading is masked on both sides.
    const recorded = RECORDED.handEditedExtra;

    const ws = path.join(config.home(), 'repros', 'alpha');
    fs.mkdirSync(ws, { recursive: true });
    const log = path.join(config.home(), 'audit.log');
    const ours: unknown[] = [];
    for (const extra of SHAPES) {
      fs.writeFileSync(path.join(ws, 'repro.json'), JSON.stringify({ ...RECORD, extra }, null, 2));
      fs.rmSync(log, { force: true });
      const gate = await outcome(async () => [
        [...(await mayChown('alpha', '123'))],
        [...(await mayChown('alpha', 'bob'))],
      ]);
      const res = await outcome(async () => await setOwner('alpha', 'bob'));
      const text = fs
        .readFileSync(path.join(ws, 'repro.json'), 'utf8')
        .replace(/"at": "[^"]*"/gu, '"at": "AT"');
      const audit = fs.existsSync(log)
        ? (fs.readFileSync(log, 'utf8').trimEnd().split('\n').pop() ?? '').split('\t').slice(2)
        : [];
      ours.push([gate, res, text, audit]);
    }
    expect(ours).toEqual(recorded);
  });

  it('is handed over with its key order and its numbers as the record spelled them', async () => {
    // The TEXT of each extra, since the point is what a plain object and a double lose of
    // it: `setOwner` rewrites the whole record, and earlier releases keep `extra.env` as
    // b, 10, a, 2 and `extra.seed.n` as 12345678901234567890, where this build wrote the
    // env as 2, 10, b, a and the int as 12345678901234567000.
    const EXTRAS = [
      '{"env": {"b": "1", "10": "2", "a": "3", "2": "4"}}',
      '{"seed": {"n": 12345678901234567890}}',
      '{"owner": "alice", "owner_history": [{"from": "", "to": "alice", "by": "", "at": 1e16}], ' +
        '"3": 3.0, "a": -9007199254740993}',
    ];
    const head = JSON.stringify(RECORD).slice(0, -1);
    // What earlier releases wrote after each handover, recorded.
    const recorded = RECORDED.keyOrderAndNumbers;
    const ws = path.join(config.home(), 'repros', 'alpha');
    fs.mkdirSync(ws, { recursive: true });
    const ours: string[] = [];
    for (const extra of EXTRAS) {
      fs.writeFileSync(path.join(ws, 'repro.json'), `${head}, "extra": ${extra}}`);
      await setOwner('alpha', 'bob');
      ours.push(
        fs
          .readFileSync(path.join(ws, 'repro.json'), 'utf8')
          .replace(/"at": "[^"]*"/gu, '"at": "AT"'),
      );
    }
    expect(ours).toEqual(recorded);
    expect(ours[1]).toContain('"n": 12345678901234567890');
  });
});

describe('every verb that destroys a colleague’s data', () => {
  const GOOD = 'correct-horse-battery';

  beforeEach(() => {
    fs.rmSync(path.join(config.home(), 'users'), { force: true });
    fs.rmSync(path.join(config.home(), 'repros'), { recursive: true, force: true });
  });
  afterEach(() => {
    jest.dontMock('../../../src/core/runner/engine');
    jest.resetModules();
  });

  async function handedToAlice(): Promise<void> {
    // The reachable shape: bob made `bob-rc`, then handed it to alice with `chown`.
    await add('alice', GOOD, 'member');
    await add('bob', GOOD, 'member');
    await writeRecord(
      'bob-rc',
      metadata({
        name: 'bob-rc',
        project: 'houston-bob-rc',
        rcVersion: '8.5.1',
        extra: { created_by: 'alice' },
      }),
    );
    fs.writeFileSync(
      path.join(config.home(), 'repros', 'bob-rc', 'docker-compose.yml'),
      'services: {}\n',
    );
  }

  it('refuses a rollback and a restore over somebody else’s workspace', async () => {
    // `down --volumes` and `prune` were gated; `upgrade --rollback` drops the database and
    // `restore` writes a bundle over it, just as thoroughly.
    await handedToAlice();
    const { rollback } = require('../../../src/core/upgrade') as typeof UpgradeNS;
    const { restore } = require('../../../src/core/backup') as typeof BackupNS;
    await runWithContext({ actor: 'bob' }, async () => {
      await expect(rollback('bob-rc')).rejects.toThrow(/belongs to alice/u);
      await expect(restore('/nonexistent.tar.gz', { name: 'bob-rc' })).rejects.toThrow(
        /belongs to alice/u,
      );
    });
  });

  it('refuses `up --fresh` before the volume teardown runs', async () => {
    // `--fresh` runs the identical `compose down -v` that `down --volumes` is gated on.
    await handedToAlice();
    const torn: unknown[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/engine'),
      down: async (...args: unknown[]) => {
        torn.push(args);
        return 0;
      },
      up: async () => 0,
    }));
    const { createRepro } =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const { createReq } = require('../../../src/core/lifecycle/types') as typeof TypesNS;
    const context = require('../../../src/lib/context') as typeof ContextNS;
    const errors = require('../../../src/lib/errors') as typeof ErrorsNS;
    await context.runWithContext({ actor: 'bob' }, async () => {
      const refused = createRepro(
        createReq({ version: '8.5.1', name: 'rc', fresh: true, actor: 'bob', offline: true }),
      );
      await expect(refused).rejects.toThrow(errors.ConflictError);
      await expect(refused).rejects.toThrow(/belongs to alice/u);
    });
    expect(torn).toEqual([]);
  });
});

describe('what `down --volumes` reports', () => {
  afterEach(() => {
    jest.dontMock('../../../src/core/lifecycle/destroy');
    jest.restoreAllMocks();
    jest.resetModules();
  });

  async function down(
    name: string,
    result: Record<string, unknown>,
    warning = '',
  ): Promise<{ code: number; out: string }> {
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/destroy', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/destroy'),
      teardown: async (_name: string, opts: { emit?: (event: unknown) => void }) => {
        if (warning) opts.emit?.({ message: warning, phase: 'teardown', level: 'warn' });
        return result;
      },
    }));
    const app = require('../../../src/cli/app') as typeof AppNS;
    const handlers = require('../../../src/cli/handlers') as typeof HandlersNS;
    let out = '';
    const io = {
      writeOut: (value: string) => {
        out += value;
      },
      writeErr: (value: string) => {
        out += value;
      },
    };
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    const code = await app.runCli(['down', '--name', name, '--volumes', '--yes'], {
      execute: handlers.createExecutor(io),
      io,
    });
    return { code, out };
  }

  it('reports the result, not the flag: a refused teardown is not a success', async () => {
    // `down --volumes` printed "removed" from the FLAG. A teardown that refused -- and said
    // the record was deliberately KEPT -- was reported as complete success, exit 0, with
    // the warning going nowhere because the CLI passed no emit.
    await writeRecord('stuck', metadata({ name: 'stuck', project: 'houston-stuck' }));
    const refused = await down(
      'stuck',
      { name: 'stuck', removed: false, found: false, runtime: 'kubernetes' },
      "'stuck': the namespace is not confirmed gone, so the local record is KEPT.",
    );
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain('was NOT removed');
    expect(refused.out).toContain('not confirmed gone');
    expect(refused.out).not.toContain('✓');

    await writeRecord('ok', metadata({ name: 'ok', project: 'houston-ok' }));
    const removed = await down('ok', {
      name: 'ok',
      removed: true,
      found: true,
      runtime: 'kubernetes',
    });
    expect(removed.code).toBe(0);
    expect(removed.out).toContain('removed');
    expect(removed.out).not.toContain('NOT removed');
  });
});

describe('carryOwnership', () => {
  const meta = (extra: Record<string, unknown>) => {
    const m = metadata({ name: 'w', rcVersion: '8.8.0' });
    m.extra = extra;
    return m;
  };
  it('keeps a handed-over owner and its history on a record rebuilt by somebody else', () => {
    const before = meta({
      created_by: 'mem2',
      owner: 'mem',
      owner_history: [{ from: 'mem2', to: 'mem', by: 'admin', at: '2026-10-12T13:00:00Z' }],
    });
    const rebuilt = meta({ created_by: 'mem2' });
    carryOwnership(before, rebuilt);
    expect(rebuilt.extra).toMatchObject({ owner: 'mem', owner_history: [{ to: 'mem' }] });
  });
  it('leaves a first create, with nothing before it, alone', () => {
    const fresh = meta({ created_by: 'mem2' });
    carryOwnership(null, fresh);
    expect(fresh.extra).toEqual({ created_by: 'mem2' });
  });
});
