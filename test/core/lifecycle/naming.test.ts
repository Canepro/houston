import { ValidationError } from '../../../src/lib/errors';
import { metadata, writeRecord } from '../../../src/core/runner/record';

import {
  NAME_MAX,
  deriveFor,
  deriveName,
  nameCandidates,
  ownerPrefix,
  requireValidName,
  resolveName,
  sanitize,
} from '../../../src/core/lifecycle/naming';
import { createReq } from '../../../src/core/lifecycle/types';

const NAMES = [
  'TICKET-1234',
  'ticket 1234',
  '../escape',
  'a/b',
  'a-b',
  '  spaced  ',
  'UPPER.CASE',
  'no',
  'on',
  'My Repro!',
  '-leading',
  'trailing-',
  '--double--',
  'Ünïcode',
  '',
  'rc8.5.1',
  'a..b',
  'a__b',
  'final\n',
];
const DERIVE: [string, string, string][] = [
  ['8.5.1', 'default', ''],
  ['8.5.1', 'default', 'alice'],
  ['8.0.0', 'ldap', 'bob'],
  ['8.5.1', '', 'alice'],
];
const CANDIDATES: [string, string][] = [
  ['TICKET-1234', 'alice'],
  ['test', 'alice'],
  ['alice-test', 'alice'],
  ['../../x', 'alice'],
  ['a/b', 'bob'],
  ['', ''],
  ['a-b', 'alice'],
];

describe('workspace naming', () => {
  it('sanitises, derives and resolves names exactly as earlier releases do', () => {
    // What earlier releases answered for each case, recorded.
    const recorded = {
      sanitize: [
        'ticket-1234',
        'ticket-1234',
        'escape',
        'a-b',
        'a-b',
        'spaced',
        'upper-case',
        'no',
        'on',
        'my-repro',
        'leading',
        'trailing',
        'double',
        'n-code',
        '',
        'rc8-5-1',
        'a--b',
        'a-b',
        'final',
      ],
      derive: ['rc8-5-1', 'alice-rc8-5-1', 'bob-rc8-0-0-ldap', 'alice-rc8-5-1'],
      prefix: [
        'alice-TICKET-1234',
        'alice-test',
        'alice-test',
        'alice-../../x',
        'bob-a/b',
        '',
        'alice-a-b',
      ],
      candidates: [
        ['alice-ticket-1234', 'ticket-1234'],
        ['test', 'alice-test'],
        ['alice-test'],
        ['alice-x', 'x'],
        ['bob-a-b', 'a-b'],
        [],
        ['a-b', 'alice-a-b'],
      ],
    };
    expect(NAMES.map(sanitize)).toEqual(recorded.sanitize);
    expect(DERIVE.map(([v, p, a]) => deriveName(v, p, a))).toEqual(recorded.derive);
    expect(CANDIDATES.map(([n, a]) => ownerPrefix(n, a))).toEqual(recorded.prefix);
    expect(CANDIDATES.map(([n, a]) => nameCandidates(n, a))).toEqual(recorded.candidates);
  });

  it('refuses the invalid names with earlier releases word for word', () => {
    // The quoting and the character class both reach a user-visible message. A backslash-t
    // spelled literally is a different sentence from the one earlier releases print.
    const invalid = ['UPPER', '-lead', 'space here', 'a.re', 'tab\tchar', 'x'.repeat(65)];
    // What earlier releases refused each one with, recorded.
    const recorded = [
      {
        kind: 'ValidationError',
        message: "invalid repro name 'UPPER' (lowercase letters, digits and '-' only)",
      },
      {
        kind: 'ValidationError',
        message: "invalid repro name '-lead' (lowercase letters, digits and '-' only)",
      },
      {
        kind: 'ValidationError',
        message: "invalid repro name 'space here' (lowercase letters, digits and '-' only)",
      },
      {
        kind: 'ValidationError',
        message: "invalid repro name 'a.re' (lowercase letters, digits and '-' only)",
      },
      {
        kind: 'ValidationError',
        message: "invalid repro name 'tab\\tchar' (lowercase letters, digits and '-' only)",
      },
      {
        kind: 'ValidationError',
        message:
          'repro name is 65 characters; the limit is 64 (it becomes a directory and a set of container names)',
      },
    ];
    const ours = invalid.map((value) => {
      try {
        requireValidName(value);
        return null;
      } catch (error) {
        return { kind: (error as Error).constructor.name, message: (error as Error).message };
      }
    });
    expect(ours).toEqual(recorded);
  });

  it('finds an owner-prefixed workspace when the bare name is typed', async () => {
    // Creation transforms what you type, so resolution has to apply the same transforms
    // or the name never round-trips: `up --name test` created alice-test and
    // `down --name test` answered NotFoundError once any account existed.
    await writeRecord(
      'alice-ticket-1234',
      metadata({ name: 'alice-ticket-1234', project: 'houston-alice-ticket-1234' }),
    );
    expect(await resolveName('TICKET-1234', 'alice')).toBe('alice-ticket-1234');
    expect(await resolveName('alice-ticket-1234')).toBe('alice-ticket-1234');
    await expect(resolveName('ticket-1234')).rejects.toThrow(/no repro named/);
  });
});

describe('the names people get', () => {
  it('sanitises and derives the documented examples', () => {
    expect(sanitize('RC 8.5.1!!')).toBe('rc-8-5-1');
    expect(deriveName('8.5.1', 'default')).toBe('rc8-5-1');
    expect(deriveName('8.5.1', 'ldap')).toBe('rc8-5-1-ldap');
    // No usable characters is empty, and the caller refuses it.
    expect(sanitize('...')).toBe('');
  });

  it('gives two people running the same version two workspaces', () => {
    // On a shared server the second person to run `up -v 8.5.1` silently REUSED the
    // first person's workspace, data and all.
    expect(deriveName('8.5.1', 'default')).toBe('rc8-5-1');
    expect(deriveName('8.5.1', 'default', 'alice')).toBe('alice-rc8-5-1');
    expect(deriveName('8.5.1', 'default', 'bob')).toBe('bob-rc8-5-1');
    expect(deriveName('8.5.1', 'ldap', 'alice')).toBe('alice-rc8-5-1-ldap');
  });

  it('namespaces an explicit name too, and never twice', () => {
    // Two people typing `--name test` collide exactly as derived names did. Idempotent, so
    // `up --name alice-test` does not become alice-alice-test.
    expect(ownerPrefix('test', 'alice')).toBe('alice-test');
    expect(ownerPrefix('test', 'bob')).toBe('bob-test');
    expect(ownerPrefix('alice-test', 'alice')).toBe('alice-test');
  });

  it('keeps every existing name on a machine with no accounts', () => {
    expect(deriveName('8.5.1', 'default', '')).toBe('rc8-5-1');
    expect(ownerPrefix('test', '')).toBe('test');
  });

  it('keeps a derived name a valid DNS label', () => {
    // It becomes a hostname under the front door, so a dot would break the TLS wildcard
    // silently.
    const name = deriveName('8.5.1', 'default', 'alice');
    expect(name).not.toContain('.');
    expect(sanitize(name)).toBe(name);
  });

  it('accepts a name at the length cap and refuses one past it', () => {
    // Unbounded, the name passed validation and then raised ENAMETOOLONG from the
    // filesystem -- a 500 from the web API and a raw stack trace from the CLI.
    expect(() => requireValidName('a'.repeat(NAME_MAX))).not.toThrow();
    expect(() => requireValidName('a'.repeat(NAME_MAX + 1))).toThrow(ValidationError);
    expect(() => requireValidName('a'.repeat(NAME_MAX + 1))).toThrow(/limit is/);
  });

  it('never offers a candidate that escapes the workspace directory', () => {
    // The candidates are already-legal names or sanitize() output, so a traversal cannot
    // survive to become a workspace path.
    const offered = ['../../etc', 'a/b', '..', './x', 'x/../../y'].flatMap((bad) =>
      nameCandidates(bad, 'alice'),
    );
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.filter((one) => one.includes('/') || one.includes('..'))).toEqual([]);
  });

  it('round-trips a typed name through create and resolve', async () => {
    // The README's own first example: `up --name TICKET-1234` then `down --name
    // TICKET-1234`. Creation sanitises and prefixes; resolution has to agree -- and the
    // full name still resolves to itself, never double-prefixed.
    for (const [typed, actor] of [
      ['TICKET-1234', ''],
      ['test', 'alice'],
      ['TICKET-1234', 'alice'],
    ] as const) {
      const made = deriveFor(createReq({ version: '8.5.1', name: typed, actor }));
      await writeRecord(made, metadata({ name: made, project: `houston-${made}` }));
      expect({ typed, actor, resolved: await resolveName(typed, actor) }).toEqual({
        typed,
        actor,
        resolved: made,
      });
      expect(await resolveName(made, actor)).toBe(made);
    }
  });
});

describe('a name made only of symbols', () => {
  it('sanitises to the empty string, which the create path has to refuse', () => {
    // `createRepro` guards this: an all-symbols name would otherwise write into the repros
    // root itself.
    expect(sanitize('!!!')).toBe('');
  });
});
