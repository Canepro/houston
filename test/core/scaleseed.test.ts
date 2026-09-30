import * as fs from 'node:fs';
import * as path from 'node:path';

import { DB, parseScale } from '../../src/core/scaleseed';

import type * as ModNS from '../../src/core/scaleseed';

/**
 * What earlier releases answered for the specs below, recorded: each accepted spec's
 * value, each refusal's words, the Unicode cases, and the argv of every mongosh run.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'core', 'scaleseed.json'), 'utf8'),
) as Record<'parsed' | 'refused' | 'unicode' | 'scripts', unknown>;

/** Load the module with the compose seam replaced, and collect the argv it builds. */
function withCapture(): { mod: typeof ModNS; argv: (readonly string[])[] } {
  jest.resetModules();
  const argv: (readonly string[])[] = [];
  jest.doMock('../../src/core/runner/engine', () => ({
    composeExecCapture: (_name: string, _service: string, args: readonly string[]) => {
      argv.push(args);
      return Promise.resolve([0, '{}']);
    },
  }));
  return { mod: require('../../src/core/scaleseed') as typeof ModNS, argv };
}

describe('the --scale grammar', () => {
  it('parses every shape earlier releases parse, to the same value', () => {
    const specs = [
      'users=5',
      'messages=9@team-chat',
      'users=5,messages=9@a-b',
      '  ',
      'users=5, messages=2@x',
      'users=0',
      'messages=1@a_b',
    ];
    expect(specs.map((s) => parseScale(s))).toEqual(RECORDED.parsed);
  });

  it('refuses every shape earlier releases refuse, with the same words', () => {
    // These messages are what the CLI prints verbatim; `--scale users=5@room` used to be
    // accepted and silently dropped, and `messages=10@a,messages=20@b` used to keep only
    // the second.
    const specs = [
      'nope',
      'users=5,users=6',
      'messages=1@a,messages=2@b',
      'users=99999999999',
      'messages=30000000@r',
      'users=5@room',
      'messages=5',
      'messages=5@bad room',
      'users=',
      'users=-1',
      'users=abc',
      'foo=1',
      'messages=100',
    ];
    const ours = specs.map((s) => {
      try {
        parseScale(s);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(ours).toEqual(RECORDED.refused);
  });

  it('reads digits and rooms by Unicode class as earlier releases do, and counts exactly', () => {
    // Earlier releases read a digit and a word character by the Unicode tables, where
    // JavaScript's `\d` and `\w` are ASCII even under /u; they strip their own set of
    // whitespace; and a count is an exact integer, so the cap is tested -- and a refusal
    // quotes -- the number typed, not the nearest double.
    const specs = [
      'messages=5@général',
      'users=٣',
      'users=0٣٣',
      'messages=１２@room',
      'messages=5@x²',
      'messages=5@Ⅻ',
      'messages=5@team_chat-2',
      'messages=9007199254740993@general',
      'users=99999999999999999999',
      `users=${'1'.repeat(4301)}`,
      'users=²',
      'messages=5@a\u0301',
      'messages=5@\u{116D0}',
      'users=\u{116D0}',
      '\ufeffusers=5',
      '\u001cusers=5\u001f',
    ];
    const ours = specs.map((s) => {
      try {
        return ['ok', parseScale(s)];
      } catch (error) {
        return ['refused', (error as Error).message];
      }
    });
    expect(ours).toEqual(RECORDED.unicode);
  });

  it('puts the thousands separator in the safety-cap message', () => {
    // Grouped by thousands. A cap printed as `20000000` is a number a reader has to count
    // digits in, which is the mistake the cap exists to catch.
    expect(() => parseScale('users=30000000')).toThrow('exceeds the 20,000,000 safety cap');
  });
});

describe('the generated mongosh script', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('is byte-identical to what earlier releases generated for every operation', async () => {
    // This string is evaluated by mongosh against the customer's own database. A
    // difference in it is a different set of documents, or a different set removed.
    const { mod, argv } = withCapture();
    await mod.bulkUsers('w', 7, { batch: 3 });
    await mod.bulkMessages('w', 5, 'team-chat', { batch: 2 });
    await mod.clear('w');
    expect(argv.map((a) => [...a])).toEqual(RECORDED.scripts);
  });

  it('addresses the database the workspace actually uses, falling back to the default', async () => {
    // `env --set MONGO_URL=...` is supported and documented, and hardcoding the name meant
    // the insert addressed a database Rocket.Chat was not reading -- reporting
    // `inserted: 50000` while the directory stayed empty.
    const { mod, argv } = withCapture();
    await mod.clear('w');
    // The lookup is the real one now (hoisted into `core/database-of.ts`); `w` has no
    // compose file, so the default stands -- which is what earlier releases answer when
    // their own lookup fails.
    expect(argv[0]?.[2]).toBe(`mongodb://localhost:27017/${DB}`);
    expect(await mod.dbOf('w')).toBe(DB);
  });

  it('does not re-run a partial insert when the shell printed something', async () => {
    // The `mongo` fallback exists for a MISSING binary. A non-zero exit WITH output means
    // the script ran and was killed mid-flight, and falling through would duplicate every
    // batch already committed.
    jest.resetModules();
    const shells: string[] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExecCapture: (_n: string, _s: string, args: readonly string[]) => {
        shells.push(args[0] as string);
        return Promise.resolve([137, '{"inserted": 5000}']);
      },
    }));
    const mod = require('../../src/core/scaleseed') as typeof ModNS;
    const [rc, out] = await mod.bulkUsers('w', 10000);
    expect(shells).toEqual(['mongosh']);
    expect(rc).toBe(137);
    expect(out).toContain('5000');
  });

  it('falls back to the legacy shell only when nothing was printed at all', async () => {
    jest.resetModules();
    const shells: string[] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExecCapture: (_n: string, _s: string, args: readonly string[]) => {
        shells.push(args[0] as string);
        return Promise.resolve([127, '']);
      },
    }));
    const mod = require('../../src/core/scaleseed') as typeof ModNS;
    const [rc] = await mod.bulkUsers('w', 10);
    expect(shells).toEqual(['mongosh', 'mongo']);
    expect(rc).toBe(1);
  });

  it('matches the pre-rename tag as well as its own', async () => {
    // The tag lives in the WORKSPACE's own MongoDB, so a rename cannot reach it. Clearing
    // only the new tag would leave a bulk seed permanently unremovable, with no error to
    // explain why nothing happened.
    const { mod, argv } = withCapture();
    await mod.clear('w');
    const script = argv[0]?.[4] ?? '';
    expect(script).toContain('houston_scale');
    expect(script).toContain('rcrepro_scale');
    // And it never WRITES the old one.
    const { mod: writer, argv: written } = withCapture();
    await writer.bulkUsers('w', 1);
    expect(written[0]?.[4]).not.toContain('rcrepro_scale');
  });
});

describe('a room reference in --scale', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('cannot reach the script unquoted: the grammar refuses it, and the script quotes it', async () => {
    // The spec's room ends up inside a mongosh script run against the customer's database.
    // The whitelist is the real guard; the quoted interpolation is the second layer.
    for (const bad of ["ev'il", 'ev"il', 'ev\\il', 'ev\nil', 'a b', 'a;b', '$where']) {
      expect(() => parseScale(`messages=1@${bad}`)).toThrow();
    }
    const { mod, argv } = withCapture();
    await mod.bulkMessages('x', 1, 'team-chat');
    expect(argv.map((a) => a.join(' ')).join('\n')).toContain("'team-chat'");
  });
});
