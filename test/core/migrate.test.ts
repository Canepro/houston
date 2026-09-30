import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as ConfigNS from '../../src/lib/config';
import type * as JsonTextNS from '../../src/lib/json-text';

import type * as ModNS from '../../src/core/migrate';
import type * as RecordNS from '../../src/core/runner/record';
import type * as EventlogMod from '../../src/core/eventlog';

let agentHome: string;
let fakeUserHome: string;

/** Load `migrate` with Docker, the edge and the skill installer all stubbed out. */
function load(
  answers: {
    docker?: (argv: readonly string[]) => Promise<{ stdout: string; exitCode: number }>;
    dockerAvailable?: boolean;
    edgeInstalled?: boolean;
    edgeUp?: number;
    skillInstall?: () => void;
    metas?: Record<string, unknown>[];
    /** The real record layer, for the case that reads back what the move carried. */
    realRecords?: boolean;
    /** What `os.homedir()` answers, when it is not the fake user home. */
    homedir?: () => string;
  } = {},
): { mod: typeof ModNS; said: string[]; calls: string[][]; config: typeof ConfigNS } {
  jest.resetModules();
  const said: string[] = [];
  const calls: string[][] = [];
  // `node:os` is mocked rather than spied on, because swc compiles `import * as os` into
  // an interop wildcard that COPIES the module's properties at import time -- so a
  // `jest.spyOn(os, 'homedir')` in this file never reaches the copy `lib/config` holds,
  // and `config.home()` would answer the developer's real `~/.houston`.
  jest.doMock('node:os', () => ({
    ...(jest.requireActual('node:os') as Record<string, unknown>),
    homedir: answers.homedir ?? (() => fakeUserHome),
  }));
  jest.doMock('../../src/seams/docker-cli', () => ({
    docker: (argv: readonly string[]) => {
      calls.push([...argv]);
      return answers.docker?.(argv) ?? Promise.resolve({ stdout: '', exitCode: 0, stderr: '' });
    },
  }));
  jest.doMock('../../src/core/runner/host', () => ({
    dockerAvailable: () => Promise.resolve(answers.dockerAvailable ?? false),
  }));
  jest.doMock('../../src/core/edge/spec', () => ({
    installed: () => answers.edgeInstalled ?? false,
    write: () => Promise.resolve(),
  }));
  jest.doMock('../../src/core/edge/runtime', () => ({
    up: () => Promise.resolve({ returncode: answers.edgeUp ?? 0 }),
  }));
  // THE REAL `skill` MODULE, pointed at a disposable agent home, with only `install`
  // replaceable. This used to supply its own `target()` returning
  // `<agent home>/.claude/skills/houston` -- one component shorter than the real one,
  // which ends in `SKILL.md`. `adoptSkillCopies` derives the pre-rename directory from
  // that, so the derivation was right against the double and wrong against production: it
  // looked for `houston/rc-repro` instead of `rc-repro` and never found a stranded skill
  // on any real box, while this file stayed green. A double whose shape differs from the
  // real return value is the payload-shape trap; the fix is to stop having one.
  if (answers.skillInstall !== undefined) {
    jest.doMock('../../src/core/skill', () => ({
      ...(jest.requireActual('../../src/core/skill') as Record<string, unknown>),
      install: answers.skillInstall,
    }));
  }
  const metas = answers.metas ?? [];
  if (answers.realRecords === true) {
    jest.doMock('../../src/core/runner/record', () =>
      jest.requireActual('../../src/core/runner/record'),
    );
  } else
    jest.doMock('../../src/core/runner/record', () => ({
      listMeta: () => Promise.resolve(metas),
      updateMeta: (name: string, mutate: (m: Record<string, unknown>) => void) => {
        const found = metas.find((m) => m.name === name);
        if (found !== undefined) mutate(found);
        return Promise.resolve();
      },
    }));
  const mod = require('../../src/core/migrate') as typeof ModNS;
  // The SAME fresh instance `migrate` just imported. Returning it is what keeps a test
  // from calling the top-level `config` binding -- which was loaded before this file's
  // `jest.resetModules()` and therefore holds the REAL `node:os`, so after
  // `unsetHoustonHome()` its `home()` would answer the developer's own `~/.houston`.
  const config = require('../../src/lib/config') as typeof ConfigNS;
  return { mod, said, calls, config };
}

const emit = (said: string[]) => (e: { message: string }) => said.push(e.message);

let previousHome: string | undefined;

beforeEach(() => {
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-agent-'));
  fakeUserHome = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-user-'));
  // A HOME of our own, and a state directory INSIDE it, so `config.home()` answers the
  // same path whether or not `HOUSTON_HOME` is set -- which is what lets one test delete
  // the variable to exercise `legacyHome()` without moving the state anywhere else.
  previousHome = process.env.HOUSTON_HOME;
  process.env.HOUSTON_HOME = path.join(fakeUserHome, '.houston');
  // `skill` writes where an AGENT looks, which is the developer's real `~/.claude` unless
  // something points it elsewhere. `testsetup` clears this along with every other
  // HOUSTON_* name, so it has to be set per test rather than relied on.
  process.env.HOUSTON_SKILL_HOME = agentHome;
});
afterEach(() => {
  delete process.env.HOUSTON_SKILL_HOME;
  if (previousHome === undefined) delete process.env.HOUSTON_HOME;
  else process.env.HOUSTON_HOME = previousHome;
  fs.rmSync(agentHome, { recursive: true, force: true });
  fs.rmSync(fakeUserHome, { recursive: true, force: true });
  jest.restoreAllMocks();
  jest.resetModules();
});

/** Let `legacyHome()` see the directory: it refuses outright while HOUSTON_HOME is set. */
function unsetHoustonHome(): void {
  delete process.env.HOUSTON_HOME;
}

function legacyDir(): string {
  return path.join(fakeUserHome, '.rc-repro');
}

function write(dir: string, rel: string, text: string): void {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
}

describe('adopting the pre-rename state directory', () => {
  it('moves it, and never merges two directories that both hold state', async () => {
    // A migration that recreated a workspace would destroy the customer data the repro
    // exists to hold, so this moves and never rebuilds.
    unsetHoustonHome();
    write(legacyDir(), 'config.yaml', 'default_repro: T-1\n');
    const { mod, said, config } = load();
    const result = await mod.migrate(emit(said));
    expect(result.moved).toBe(true);
    expect(fs.existsSync(legacyDir())).toBe(false);
    expect(fs.readFileSync(path.join(config.home(), 'config.yaml'), 'utf8')).toContain('T-1');
    expect(said.join(' ')).toContain('moved ');
  });

  it('refuses when both directories hold state, rather than choosing for the operator', async () => {
    unsetHoustonHome();
    write(legacyDir(), 'config.yaml', 'a: 1\n');
    const { mod, config } = load();
    write(config.home(), 'config.yaml', 'b: 2\n');
    await expect(mod.migrate()).rejects.toThrow('there is no safe move to make');
    // Both are untouched.
    expect(fs.existsSync(path.join(legacyDir(), 'config.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(config.home(), 'config.yaml'), 'utf8')).toContain('b: 2');
  });

  it('treats a home holding nothing but its own event log as empty', async () => {
    // `logs/houston.log` is opened by the first command that runs at all, so a box that
    // ran a single `houston --version` has a non-empty home holding a record of that one
    // command. Treating that as "state" refuses the migration forever.
    unsetHoustonHome();
    write(legacyDir(), 'config.yaml', 'a: 1\n');
    const { mod, config } = load();
    write(config.home(), 'logs/houston.log', '{"type":"houston.event.v1"}\n');
    expect((await mod.migrate()).moved).toBe(true);
    expect(fs.readFileSync(path.join(config.home(), 'config.yaml'), 'utf8')).toContain('a: 1');
  });

  it('refuses a destination it cannot read, rather than calling it empty and removing it', async () => {
    // DELIBERATELY NOT WHAT EARLIER RELEASES DID. Their walk swallowed a permission error
    // and yielded nothing, so their emptiness check answered true for a state directory it
    // could not read -- and the only caller then removed it, recursively. A read that
    // failed is not an empty directory, and the operator gets the refusal that names both
    // homes instead.
    unsetHoustonHome();
    write(legacyDir(), 'config.yaml', 'a: 1\n');
    const { mod, config } = load();
    write(config.home(), 'secret.txt', 'state nobody can list\n');
    fs.chmodSync(config.home(), 0o000);
    try {
      expect(mod.isEffectivelyEmpty(config.home())).toBe(false);
      await expect(mod.migrate()).rejects.toThrow('there is no safe move to make');
    } finally {
      fs.chmodSync(config.home(), 0o755);
    }
    expect(fs.readFileSync(path.join(config.home(), 'secret.txt'), 'utf8')).toContain('nobody');
  });

  it('calls a destination that simply is not there empty', async () => {
    const { mod, config } = load();
    expect(mod.isEffectivelyEmpty(path.join(config.home(), 'never-created'))).toBe(true);
  });

  it('does nothing at all when HOUSTON_HOME was set by hand', async () => {
    // Moving a directory an operator named by hand is not a decision this gets to make on
    // their behalf. `doctor` reports that case instead.
    write(legacyDir(), 'config.yaml', 'a: 1\n');
    const { mod } = load();
    expect(mod.legacyHome()).toBeNull();
    expect((await mod.migrate()).moved).toBe(false);
    expect(fs.existsSync(legacyDir())).toBe(true);
  });

  it('is the directory earlier releases adopt, whatever HOME is spelled as', () => {
    // With HOME set but EMPTY, `os.homedir()` is '' and this found `.rc-repro` in the
    // WORKING directory -- and would have moved it onto a home earlier releases never read.
    // Earlier releases look for `/.rc-repro`. So the working directory holds a decoy, and the
    // rows are `lib/home.ts`'s: empty, the root spelled twice, trailing slashes. Under Jest
    // `os.homedir()` is answered by the mock, with HOME verbatim, as the native call does
    // (`lib/home.test.ts` checks that premise against real processes).
    unsetHoustonHome();
    fs.mkdirSync(legacyDir());
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-cwd-'));
    fs.mkdirSync(path.join(decoy, '.rc-repro'));
    const rows = ['', '/', '//', `${fakeUserHome}/`, `${fakeUserHome}//`];
    const cwd = process.cwd();
    let current = '';
    try {
      const { mod } = load({ homedir: () => current });
      process.chdir(decoy);
      const ours = rows.map((row) => {
        current = row;
        return mod.legacyHome();
      });
      // What earlier releases adopted for each row, recorded: nothing under the root
      // however it is spelled, and the home's `.rc-repro` under both home spellings.
      const recorded = [null, null, null, `${fakeUserHome}/.rc-repro`, `${fakeUserHome}/.rc-repro`];
      expect(ours).toEqual(recorded);
      // And the rows that CAN hold one found it: the comparison is not all nulls.
      expect(ours.slice(3)).toEqual([legacyDir(), legacyDir()]);
    } finally {
      process.chdir(cwd);
      fs.rmSync(decoy, { recursive: true, force: true });
    }
  });
});

describe('finishing an interrupted move', () => {
  it('rewrites the old name out of COMMENT lines only', async () => {
    // `users` holds account names and password hashes on its other lines, and a blanket
    // substitution there could rewrite somebody's username.
    const { mod, said, config } = load();
    write(config.home(), 'users', '# rc-repro users\nrc-repro-bob\thash\tadmin\n');
    write(config.home(), 'sessions', '# rc-repro-state: 1\n');
    const result = await mod.migrate(emit(said));
    expect(result.markers.sort()).toEqual(['sessions', 'users']);
    const users = fs.readFileSync(path.join(config.home(), 'users'), 'utf8');
    expect(users).toContain('# houston users');
    expect(users).toContain('rc-repro-bob\thash\tadmin');
    expect(fs.readFileSync(path.join(config.home(), 'sessions'), 'utf8')).toBe(
      '# houston-state: 1\n',
    );
  });

  it('rewrites a comment line only, on every line break earlier releases honour', async () => {
    // Earlier releases break lines on CR, VT, FF, the separators, NEL and U+2028/9, not just
    // `\n`. Splitting on `\n` alone made this whole file ONE line starting with `#`, so the
    // substitution ran over the account row too and renamed `rc-repro-bob` to
    // `houston-bob` -- the corruption the comment-lines-only rule exists to prevent.
    const { mod, config } = load();
    write(config.home(), 'users', '# rc-repro users\rrc-repro-bob\thash\tadmin\n');
    write(config.home(), 'sessions', 'data # rc-repro-state: 1\n');
    write(config.home(), 'first-run', '# rc-repro tokenrc-repro-tail\n');
    const result = await mod.migrate();
    expect(result.markers.sort()).toEqual(['first-run', 'sessions', 'users']);
    // The account name survives; the comment does not. CR becomes LF because earlier
    // releases read the file with universal newlines, and this must write the bytes they did.
    expect(fs.readFileSync(path.join(config.home(), 'users'), 'utf8')).toBe(
      '# houston users\nrc-repro-bob\thash\tadmin\n',
    );
    expect(fs.readFileSync(path.join(config.home(), 'sessions'), 'utf8')).toBe(
      'data # houston-state: 1\n',
    );
    expect(fs.readFileSync(path.join(config.home(), 'first-run'), 'utf8')).toBe(
      '# houston tokenrc-repro-tail\n',
    );
  });

  it('keeps a file without a trailing newline without one', async () => {
    const { mod, config } = load();
    write(config.home(), 'first-run', '# rc-repro first run');
    await mod.migrate();
    expect(fs.readFileSync(path.join(config.home(), 'first-run'), 'utf8')).toBe(
      '# houston first run',
    );
  });

  it('renames the log, and parks a collision beside it rather than skipping', async () => {
    // Skipping would leave `pending()` true for ever and re-run this on every command.
    const { mod, config } = load();
    write(config.home(), 'logs/rc-repro.log', 'one\n');
    write(config.home(), 'logs/rc-repro.log.1', 'two\n');
    write(config.home(), 'logs/houston.log', 'already\n');
    const result = await mod.migrate();
    expect(result.logs_renamed).toBe(2);
    const logs = fs.readdirSync(path.join(config.home(), 'logs')).sort();
    expect(logs).toEqual(['houston.log', 'houston.log.1', 'rc-repro.log.pre-rename']);
  });

  it('is finished by the next run, which is what makes the journal unnecessary', async () => {
    const { mod, config } = load();
    write(config.home(), 'logs/rc-repro.log', 'one\n');
    write(config.home(), 'users', '# rc-repro users\n');
    expect(mod.pending()).toBe(true);
    await mod.migrate();
    expect(mod.pending()).toBe(false);
    // And running it again changes nothing.
    const second = await mod.migrate();
    expect(second.markers).toEqual([]);
    expect(second.logs_renamed).toBe(0);
  });

  it('regenerates the edge from a spec.json an earlier release wrote', async () => {
    // A pre-rename home is by definition one an earlier release wrote, and it spells
    // these keys `acme_email`/`gui_host`. Validating against the camelCase property
    // names rejected every spec.json in existence, so `edge_regenerated` was false for
    // everybody -- and the compose file kept an ACME path naming the directory the move had
    // just deleted. Docker then creates that path empty and root-owned and the edge
    // re-requests every certificate it held against production Let's Encrypt.
    unsetHoustonHome();
    write(legacyDir(), 'config.yaml', 'a: 1\n');
    write(
      legacyDir(),
      path.join('edge', 'spec.json'),
      JSON.stringify({
        domain: 'support.example.com',
        acme_email: 'ops@example.com',
        acme_staging: false,
        acme_challenge: 'tlsalpn',
        acme_dns_provider: '',
        gui_host: '0.0.0.0',
        gui_port: 9944,
        http_port: 80,
        https_port: 443,
        wildcard: false,
      }),
    );
    const { mod, said } = load();
    expect((await mod.migrate(emit(said))).edge_regenerated).toBe(true);
    expect(said.join(' ')).toContain('regenerated the edge configuration');
  });

  it('refuses a spec.json carrying a field it does not know, rather than defaulting it', async () => {
    // Earlier releases refused a field they did not know. A partial spread would accept
    // a spec written by a build that has since renamed a field and silently use the default
    // -- which is how an edge comes back up serving a different domain than the one
    // recorded. The refusal is reported, not raised: a migration must still finish.
    unsetHoustonHome();
    write(legacyDir(), 'config.yaml', 'a: 1\n');
    write(
      legacyDir(),
      path.join('edge', 'spec.json'),
      JSON.stringify({ domain: 'x.example.com', acmeEmail: 'ops@example.com' }),
    );
    const { mod, said } = load();
    expect((await mod.migrate(emit(said))).edge_regenerated).toBe(false);
    expect(said.join(' ')).toContain('unexpected edge field(s): acmeEmail');
  });

  it('records the namespace a pre-rename Kubernetes workspace is already in', async () => {
    // `namespaceFor` would otherwise derive `houston-<name>` for objects sitting in
    // `rc-repro-<name>` -- sending a later `down` at a namespace that was never created
    // while the real one keeps its pods, its PVCs and its port-forward.
    const metas = [
      { name: 'k1', extra: { runtime: 'kubernetes' } },
      { name: 'k2', extra: { runtime: 'kubernetes', namespace: 'already-here' } },
      { name: 'd1', extra: {} },
    ];
    const { mod } = load({ metas });
    const result = await mod.migrate();
    expect(result.namespaces_recorded).toEqual(['k1']);
    expect((metas[0] as { extra: Record<string, unknown> }).extra.namespace).toBe('rc-repro-k1');
    expect((metas[1] as { extra: Record<string, unknown> }).extra.namespace).toBe('already-here');
    expect((metas[2] as { extra: Record<string, unknown> }).extra.namespace).toBeUndefined();
  });

  it('treats every value earlier releases call falsy as a namespace never recorded', async () => {
    // Earlier releases test the namespace for truth, not for presence. Enumerating only
    // undefined/null/'' left a workspace carrying `0`, `false`, `[]` or `{}` unstamped --
    // and an unstamped Kubernetes workspace is one a later `down` aims at a namespace that
    // was never created, while the real one keeps its pods, its PVCs and its port-forward.
    const metas = [
      { name: 'zero', extra: { runtime: 'kubernetes', namespace: 0 } },
      { name: 'no', extra: { runtime: 'kubernetes', namespace: false } },
      { name: 'list', extra: { runtime: 'kubernetes', namespace: [] } },
      { name: 'bag', extra: { runtime: 'kubernetes', namespace: {} } },
      { name: 'real', extra: { runtime: 'kubernetes', namespace: 'kept' } },
    ];
    const { mod } = load({ metas });
    expect((await mod.migrate()).namespaces_recorded).toEqual(['zero', 'no', 'list', 'bag']);
    expect((metas[4] as { extra: Record<string, unknown> }).extra.namespace).toBe('kept');
  });

  it('stamps it into a copy that keeps the record as earlier releases kept it', async () => {
    // The copy is what the record update writes back, and earlier releases kept a
    // hand-edited record's key order and its ints whole. A spread is a new
    // object in JavaScript's order, with nothing of the record's spelling beside it, so the
    // stamp moved `10` first and wrote 12345678901234567890 as 12345678901234567000.
    // `loads` from the registry `migrate` itself was loaded in.
    const text =
      '{"runtime": "kubernetes", "b": 1, "10": "x", "n": 12345678901234567890, "f": 1e16}';
    const metas: Record<string, unknown>[] = [{ name: 'k1', extra: {} }];
    const { mod } = load({ metas });
    const jsonText = require('../../src/lib/json-text') as typeof JsonTextNS;
    (metas[0] as { extra: unknown }).extra = jsonText.loads(text);
    expect((await mod.migrate()).namespaces_recorded).toEqual(['k1']);
    // What earlier releases wrote for the stamped copy, recorded.
    const recorded = [
      '{',
      '  "runtime": "kubernetes",',
      '  "b": 1,',
      '  "10": "x",',
      '  "n": 12345678901234567890,',
      '  "f": 1e+16,',
      '  "namespace": "rc-repro-k1"',
      '}',
    ].join('\n');
    expect(jsonText.dumps((metas[0] as { extra: unknown }).extra, { indent: 2 })).toBe(recorded);
  });
});

describe('the leftovers outside the state directory', () => {
  it('replaces an agent skill installed under the old name', async () => {
    // The stale SKILL.md keeps teaching agents to run `rc-repro <cmd>`, a command that no
    // longer exists, and an agent following it fails in a way that looks like the agent's
    // fault.
    // BOTH hosts, through the real `skill` module. The copy sits BESIDE the new directory
    // (`<host>/rc-repro`), not inside it; deriving it as `dirname(target(host))` pointed at
    // `<host>/houston/rc-repro` and found nothing on any real box.
    for (const host of ['.claude', '.agents']) {
      fs.mkdirSync(path.join(agentHome, host, 'skills', 'rc-repro'), { recursive: true });
      fs.writeFileSync(
        path.join(agentHome, host, 'skills', 'rc-repro', 'SKILL.md'),
        '# run `rc-repro up`\n',
      );
    }
    const { mod, said } = load();
    const result = await mod.migrate(emit(said));
    expect(result.skills_replaced).toHaveLength(2);
    for (const host of ['.claude', '.agents']) {
      expect(fs.existsSync(path.join(agentHome, host, 'skills', 'rc-repro'))).toBe(false);
      expect(fs.existsSync(path.join(agentHome, host, 'skills', 'houston', 'SKILL.md'))).toBe(true);
    }
    expect(said.join(' ')).toContain('replaced 2 pre-rename agent skill');
  });

  it('keeps a locally edited skill rather than discarding somebody changes', async () => {
    fs.mkdirSync(path.join(agentHome, '.claude', 'skills', 'rc-repro'), { recursive: true });
    const { mod, said } = load({
      skillInstall: () => {
        throw new Error('SKILL.md was edited locally');
      },
    });
    const result = await mod.migrate(emit(said));
    expect(result.skills_replaced).toEqual([]);
    expect(fs.existsSync(path.join(agentHome, '.claude', 'skills', 'rc-repro'))).toBe(true);
    expect(said.join(' ')).toContain('houston skill install');
  });

  it('hands the shared edge over instead of leaving a proxy that is fine until it is not', async () => {
    // The old container's bind mounts point into a directory that no longer exists. It
    // keeps serving only because Linux holds those inodes open; the first restart
    // re-resolves the paths, creates them empty and root-owned, and the edge comes back
    // reporting `running` while serving no route and no certificate at all.
    unsetHoustonHome();
    write(legacyDir(), 'config.yaml', 'a: 1\n');
    const { mod, said, calls } = load({
      dockerAvailable: true,
      edgeInstalled: true,
      docker: (argv) =>
        Promise.resolve(
          argv[0] === 'ps'
            ? { stdout: 'rcrepro_edge-traefik-1\n', exitCode: 0 }
            : { stdout: '', exitCode: 0 },
        ),
    });
    const result = await mod.migrate(emit(said));
    expect(result.legacy_edge).toBe('rcrepro_edge-traefik-1');
    expect(calls.some((c) => c.join(' ').includes('compose -p rcrepro_edge down'))).toBe(true);
    expect(said.join(' ')).toContain('serving again on :80 and :443');
  });

  it('names the two commands that finish the job when it cannot stop the old edge', async () => {
    unsetHoustonHome();
    write(legacyDir(), 'config.yaml', 'a: 1\n');
    const { mod, said } = load({
      dockerAvailable: true,
      edgeInstalled: true,
      docker: (argv) =>
        Promise.resolve(
          argv[0] === 'ps'
            ? { stdout: 'rcrepro_edge-traefik-1\n', exitCode: 0 }
            : { stdout: '', exitCode: 1 },
        ),
    });
    await mod.migrate(emit(said));
    expect(said.join(' ')).toContain('docker compose -p rcrepro_edge down');
    expect(said.join(' ')).toContain('houston edge start');
  });

  it('does nothing about Docker at all on a box that has none', async () => {
    unsetHoustonHome();
    write(legacyDir(), 'config.yaml', 'a: 1\n');
    const { mod, calls } = load({ dockerAvailable: false });
    expect((await mod.migrate()).legacy_edge).toBe('');
    expect(calls).toEqual([]);
  });
});

describe('adopting a real workspace', () => {
  it('carries it across still addressed by the names its containers and namespace carry', async () => {
    // Recreating anything here would destroy the customer data a repro exists to hold, so
    // the check is that the OLD project and the OLD namespace survive the move -- read back
    // through the real record layer, not a double of it.
    unsetHoustonHome();
    write(
      legacyDir(),
      'repros/w1/repro.json',
      JSON.stringify({
        name: 'w1',
        project: 'rcrepro-w1',
        rc_version: '8.5.1',
        rc_image: 'rc',
        mongo_tag: '7.0',
        mongo_flavor: 'official',
        preset: 'default',
        root_url: 'http://localhost:3000',
        host_port: 3000,
        version_source: 'live',
        public_url: 'https://w1.rcrepro.localhost',
        extra: { runtime: 'kubernetes', tls: 'local' },
      }),
    );
    write(legacyDir(), 'sessions', '# rc-repro GUI sessions.\n# rc-repro-state: 2\n');
    write(legacyDir(), 'logs/rc-repro.log', '{"ts":"old"}\n');
    const { mod, config } = load({ realRecords: true });
    const result = await mod.migrate();
    expect(result.moved).toBe(true);
    // The old directory is not left behind.
    expect(fs.existsSync(legacyDir())).toBe(false);
    expect(fs.existsSync(path.join(config.home(), 'repros', 'w1', 'repro.json'))).toBe(true);
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    // Adopted, not re-minted.
    expect(await record.projectName('w1')).toBe('rcrepro-w1');
    expect(result.namespaces_recorded).toEqual(['w1']);
    expect((await record.readMeta('w1')).extra.namespace).toBe('rc-repro-w1');
  });
});

describe('the event log, while the migration speaks', () => {
  it('is renamed before anything is announced, or the announcement makes the rename a no-op', async () => {
    // Every event is TEED into the event log, which opens logs/houston.log as a side
    // effect. A migration that announced the move before renaming the log would create
    // the destination itself: the box keeps logs/rc-repro.log for ever and the whole
    // migration re-runs on every command.
    unsetHoustonHome();
    write(legacyDir(), 'repros/w1/repro.json', '{"name": "w1"}');
    write(legacyDir(), 'logs/rc-repro.log', '{"ts":"old"}\n');
    const { mod, config } = load();
    const eventlog = require('../../src/core/eventlog') as typeof EventlogMod;
    eventlog.resetForTest();
    const release = eventlog.installEventlogSink();
    try {
      await mod.migrate(() => undefined);
    } finally {
      release();
    }
    const logs = path.join(config.home(), 'logs');
    expect(fs.existsSync(path.join(logs, 'rc-repro.log'))).toBe(false);
    const text = fs.readFileSync(path.join(logs, 'houston.log'), 'utf8');
    expect(text.startsWith('{"ts":"old"}')).toBe(true);
    // The sink was live: the announcement landed in the renamed file, after the old record.
    expect(text).toContain('moved ');
    expect(mod.pending()).toBe(false);
  });
});
