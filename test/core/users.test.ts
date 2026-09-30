import { spawn } from 'node:child_process';
import { scrypt as scryptCallback } from 'node:crypto';
import type * as CryptoNS from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { promisify } from 'node:util';

import * as config from '../../src/lib/config';
import { ConflictError, NotFoundError, ValidationError } from '../../src/lib/errors';
import { teamMode } from '../../src/lib/teammode';

import { read as readAudit } from '../../src/core/audit';
import type * as NamingNS from '../../src/core/lifecycle/naming';
import {
  create as createSession,
  resetCache,
  revokeUser,
  verify as verifySession,
} from '../../src/core/sessions';
import type * as UsersNS from '../../src/core/users';
import {
  IMPLICIT_ADMIN,
  MIN_PASSWORD,
  ROLES,
  SCRYPT_MAXMEM,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  add,
  admins,
  anyUsers,
  atLeast,
  check,
  defaultRoleForNewAccount,
  hashPassword,
  implicitAdmins,
  listUsers,
  mintPassword,
  normalizeName,
  normaliseRole,
  readAll,
  remove,
  requireValidName,
  requireValidPassword,
  requireValidRole,
  roleOf,
  setPassword,
  setRole,
  usersFile,
  verify,
} from '../../src/core/users';

const GOOD = 'correct horse battery';

/**
 * What earlier releases answered and wrote for the cases below, recorded: what their
 * reader made of each undecodable and hand-edited file, what they wrote back, their
 * refusals, and the accounts files they wrote.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'core', 'users.json'), 'utf8'),
) as {
  decoded: unknown[];
  shapesRead: unknown[];
  shapesRewritten: string[];
  nameAnswers: string[];
  quoting: string[][];
  aliceMember: string;
  bobReadonly: string;
  aliceAdminBobMember: string;
  concurrentLines: string[];
};

/** An accounts file with each hash and date masked, so two writes compare by layout. */
function layout(text: string): string {
  return text.replace(/^([^#:\n][^:\n]*):scrypt\$[^:\n]*:\d{4}-\d{2}-\d{2}/gmu, '$1:<hash>:<date>');
}

/** The pieces of a stored hash: the four cost fields, then the salt's and digest's lengths. */
function hashShape(stored: string): (string | number)[] {
  return stored.split('$').map((part, at) => (at < 4 ? part : Buffer.from(part, 'base64').length));
}

const scrypt = promisify(scryptCallback) as (
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

function body(): string {
  return fs.readFileSync(usersFile(), 'utf8');
}

function rows(): string[] {
  return body()
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'));
}

beforeEach(() => {
  fs.rmSync(usersFile(), { force: true });
  fs.rmSync(path.join(config.home(), 'sessions'), { force: true });
  fs.rmSync(path.join(config.home(), 'audit.log'), { force: true });
  resetCache();
});

describe('the scrypt contract', () => {
  it('uses the cost parameters earlier releases write, with maxmem stated, not inherited', () => {
    expect([SCRYPT_N, SCRYPT_R, SCRYPT_P]).toEqual([16384, 8, 1]);
    // 128 * 16384 * 8 = 16 MiB, half of this. The number is stated because Node's rule is
    // `128*N*r > maxmem` -- a strict inequality that ACCEPTS N=32768 at the same default
    // earlier releases (through OpenSSL) refuse it at. Leaving it to the default is how the
    // two runtimes end up disagreeing about a hash one of them wrote.
    expect(SCRYPT_MAXMEM).toBe(33_554_432);
    expect(128 * SCRYPT_N * SCRYPT_R).toBeLessThan(SCRYPT_MAXMEM);
  });

  it('agrees with earlier releases on every cost parameter', () => {
    // N, r, p, the digest length and the salt length earlier releases used, recorded.
    const recorded = [16384, 8, 1, 32, 16];
    expect(recorded).toEqual([SCRYPT_N, SCRYPT_R, SCRYPT_P, 32, 16]);
  });

  it('emits `scrypt$n$r$p$b64salt$b64hash`, standard base64 and not urlsafe', async () => {
    const stored = await hashPassword(GOOD, Buffer.alloc(16, 0xff));
    const parts = stored.split('$');
    expect(parts.slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
    // Standard base64, so `/` and `=` rather than the `_` urlsafe would give. A urlsafe
    // salt is still 16 bytes and still verifies under itself, so only a byte comparison
    // against the recorded hash of earlier releases catches the difference.
    expect(parts[4]).toBe('/////////////////////w==');
    expect(Buffer.from(parts[5] as string, 'base64')).toHaveLength(32);
  });

  it('derives the identical digest earlier releases derive for the same salt', async () => {
    const salt = Buffer.from([...Array(16).keys()]);
    const mine = await hashPassword(GOOD, salt);
    // What earlier releases stored for this password and the salt 0..15, recorded.
    const recorded =
      'scrypt$16384$8$1$AAECAwQFBgcICQoLDA0ODw==$6W7GuoxjojaYIg83x/wEKSXUMMf+reyc6wSvA8q7ny8=';
    expect(mine).toBe(recorded);
  });

  it('reads n, r and p FROM THE STORED LINE, so the cost can be raised per user', async () => {
    // A line at a different cost must still verify, or raising the parameter locks out
    // every account that predates the change.
    const salt = Buffer.alloc(16, 7);
    const digest = await scrypt(Buffer.from(GOOD, 'utf8'), salt, 32, {
      N: 1024,
      r: 8,
      p: 1,
      maxmem: SCRYPT_MAXMEM,
    });
    const cheap = `scrypt$1024$8$1$${salt.toString('base64')}$${digest.toString('base64')}`;
    expect(await check(GOOD, cheap)).toBe(true);
    expect(await check('wrong password here', cheap)).toBe(false);
  });

  it('is a failed check, not a crash, for every malformed stored line', async () => {
    for (const bad of ['', 'nonsense', 'bcrypt$1$2$3$4$5', 'scrypt$x$8$1$AAAA$AAAA', 'a$b$c']) {
      expect(await check(GOOD, bad)).toBe(false);
    }
  });

  it('accepts a hash an earlier release wrote, and writes one it accepts', async () => {
    // A hash of GOOD an earlier release wrote, with a salt of its own, recorded.
    const recorded =
      'scrypt$16384$8$1$/7Yk7Xb9s7LtXxVJ5fNe4g==$KEYEdVusqBrZn/hpPHZ1JOmBgwekHrhWGpKXieCWGAo=';
    expect(await check(GOOD, recorded)).toBe(true);
    expect(await check('not the password', recorded)).toBe(false);

    // An earlier release checks a stored line by deriving it again from the line's own
    // cost and salt: this build's has the recorded shape, and derives again to itself for
    // the right password and to something else for a wrong one -- the digest for a given
    // salt being the one the case above pins.
    const mine = await hashPassword(GOOD);
    expect(hashShape(mine)).toEqual(hashShape(recorded));
    const salt = Buffer.from(mine.split('$')[4] as string, 'base64');
    expect(await hashPassword(GOOD, salt)).toBe(mine);
    expect(await hashPassword('wrong', salt)).not.toBe(mine);
  });
});

describe('the users file', () => {
  it('is `name:hash:created_at[:role]` behind the two comment lines', async () => {
    await add('alice', GOOD, 'member');
    const text = body();
    expect(text.split('\n')[0]).toBe('# houston GUI accounts. Managed by `houston users`.');
    expect(text.split('\n')[1]).toBe('# name:hash:created_at[:role]');
    const parts = (rows()[0] as string).split(':');
    expect(parts[0]).toBe('alice');
    expect(parts[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(parts[3]).toBe('member');
  });

  it('stores created_at as a DATE, because ":" is the delimiter', async () => {
    // An ISO timestamp ("...T08:52:23+00:00") splits straight into the role column, so a
    // full timestamp here would silently make everybody's role "52".
    await add('alice', GOOD, 'member');
    expect((rows()[0] as string).split(':')).toHaveLength(4);
  });

  it('is created 0600, before the content is in place', async () => {
    await add('alice', GOOD);
    expect(fs.statSync(usersFile()).mode & 0o777).toBe(0o600);
  });

  it('is written in name order, so two builds produce the same bytes', async () => {
    await add('carol', GOOD, 'member');
    await add('alice', GOOD, 'member');
    await add('bob', GOOD, 'member');
    expect(rows().map((r) => r.split(':')[0])).toEqual(['alice', 'bob', 'carol']);
  });

  it('is an empty list for a missing file, not an error', () => {
    expect(listUsers()).toEqual([]);
    expect(anyUsers()).toBe(false);
    expect(roleOf('nobody')).toBe('');
  });

  it('is decoded strictly, so bytes that are not UTF-8 are refused, naming the file', () => {
    // Earlier releases decode the file strictly and catch only a failed read: their error is
    // neither a ValidationError nor an account called `al�ice`, which is what a lenient
    // `readFileSync(file, 'utf8')` made of the first shape. Each shape is compared with what
    // their reader returned or raised, recorded, as `<name>: <message>`, the file as `{USERS}`.
    const shapes = [
      'al\xffice:x:2026-01-01:admin\n', // invalid start byte
      'alice:x:2026-01-01:admin\n\xe2\x82', // cut short: unexpected end of data
      'al\xc3\x28ice:x:2026-01-01:admin\n', // invalid continuation byte
      '# comment \xe9\nalice:x:2026-01-01:admin\n', // Latin-1, in a line that is skipped anyway
      'j\xc3\xb6rg:x:2026-01-01:member\n', // UTF-8 that is not ASCII: a control, it reads
    ].map((text) => Buffer.from(text, 'latin1'));
    const ours = shapes.map((bytes) => {
      fs.writeFileSync(usersFile(), bytes);
      try {
        return Object.fromEntries(readAll());
      } catch (error) {
        return `${(error as Error).name}: ${(error as Error).message.split(usersFile()).join('{USERS}')}`;
      }
    });
    expect(ours).toEqual(RECORDED.decoded);
    expect(ours.slice(0, 4)).toEqual([
      'NotUtf8: {USERS} is not valid UTF-8 (byte 0xff at position 2: invalid start byte)',
      'NotUtf8: {USERS} is not valid UTF-8 (bytes at positions 25-26: unexpected end of data)',
      'NotUtf8: {USERS} is not valid UTF-8 (byte 0xc3 at position 2: invalid continuation byte)',
      'NotUtf8: {USERS} is not valid UTF-8 (byte 0xe9 at position 10: invalid continuation byte)',
    ]);
  });

  // Hand-edited shapes, each read and then rewritten here and by earlier releases: they
  // break lines on every line boundary, strip each line of their own set of whitespace, and
  // sort by code point when they write and list. `split('\n')`, `trim()` and a UTF-16 sort
  // lost bob from a CR-only file, took a Windows BOM off `alice` and kept `\x1c`/`\x1f` they
  // strip, and put an astral name first.
  const SHAPES: [string, string][] = [
    ['a CR-only file', 'alice:x:2026-01-02:admin\rbob:x:2026-01-03:member\r'],
    ['a form feed between lines', 'alice:x:2026-01-02:admin\fbob:x:2026-01-03:member\n'],
    [
      'every other line boundary',
      'a:x:1:admin\vb:x:2:member\x1cc:x:3:member\x1dd:x:4:member\x1ee:x:5:member\x85' +
        'f:x:6:member g:x:7:member h:x:8:readonly\n',
    ],
    ['a CRLF file', '# accounts\r\nalice:x:2026-01-02:admin\r\nbob:x:2026-01-03:member\r\n'],
    ['a Windows BOM', '﻿alice:x:2026-01-02:admin\nbob:x:2026-01-03:member\n'],
    ['information separators', '\x1calice:x:2026-01-02:admin\nbob:x:2026-01-03:member\x1f\n'],
    [
      'separators inside a role column',
      'alice:x:1:admin\ncarol:x:2:member\x1f:more\ndave:x:3:\x1c:more\nerin:x:4:﻿:more\n',
    ],
    [
      'an astral name beside a fullwidth one',
      'ａ:x:2026-01-02:admin\n\u{1d400}:x:2026-01-03:admin\n',
    ],
  ];

  it('is read as earlier releases read it, whatever an editor did to the lines', () => {
    const ours = SHAPES.map(([, text]) => {
      fs.writeFileSync(usersFile(), text);
      const read = [...readAll().entries()].map(([name, fields]) => [name, ...fields]);
      return {
        read,
        list: listUsers().map((user) => [user.name, user.createdAt, user.role]),
        roles: read.map((row) => [
          row[0],
          roleOf(row[0] as string),
          normaliseRole(row[3] as string),
        ]),
        admins: admins(),
        implicit: implicitAdmins(),
      };
    });
    expect(ours).toEqual(RECORDED.shapesRead);
    // The two a person meets: bob is still there, and the BOM keeps alice out of reach.
    expect((ours[0] as { list: string[][] }).list.map(([name]) => name)).toEqual(['alice', 'bob']);
    expect((ours[4] as { roles: string[][] }).roles[0]).toEqual(['﻿alice', '', 'admin']);
  });

  it('is rewritten as earlier releases rewrite it, after an account is added', async () => {
    const ours: string[] = [];
    for (const [, text] of SHAPES) {
      fs.writeFileSync(usersFile(), text);
      await add('zed', GOOD);
      ours.push(body());
    }
    // zed's own hash is salted and its date is today's; every other byte is the file's.
    const added = (file: string) => file.replace(/^zed:[^:]*:\d{4}-\d{2}-\d{2}:/mu, 'zed:<new>:');
    expect(ours.map(added)).toEqual(RECORDED.shapesRewritten.map(added));
    expect(ours[0]).toMatch(/^bob:x:2026-01-03:member$/mu);
  });
});

describe('a users path that is a socket', () => {
  it("is refused with the OS error's own sentence, ENXIO's included", async () => {
    // `No such device or address`: the strerror table had no ENXIO, so the refusal
    // fell back to Node's "ENXIO: no such device or address, open ..." (p12 re-verify).
    fs.mkdirSync(path.dirname(usersFile()), { recursive: true });
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(usersFile(), resolve));
    try {
      // What earlier releases raised for it, recorded.
      const recorded = `ValidationError: cannot read ${usersFile()}: No such device or address`;
      let ours = '';
      try {
        readAll();
      } catch (error) {
        ours = `${(error as Error).constructor.name}: ${(error as Error).message}`;
      }
      expect(ours).toBe(recorded);
      expect(ours).toContain('No such device or address');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('a users lock earlier releases cannot open for writing', () => {
  // `flock(1)` opened `locks/users.lock` read-only, so it took a directory or a read-only
  // file and wrote the account; earlier releases open it for writing and fail first, and a
  // locks directory they may not create is `<home>/locks: Permission denied`, not Node's
  // `EACCES: ..., mkdir`.
  // The third column is what earlier releases raised for each, recorded.
  const locks = (home: string): string => path.join(home, 'locks');
  it.each([
    [
      'a directory',
      (home: string) => fs.mkdirSync(path.join(locks(home), 'users.lock')),
      (home: string) => `FileError: ${home}/locks/users.lock: Is a directory`,
    ],
    [
      'read-only',
      (home: string) => {
        fs.writeFileSync(path.join(locks(home), 'users.lock'), '');
        fs.chmodSync(path.join(locks(home), 'users.lock'), 0o444);
      },
      (home: string) => `FileError: ${home}/locks/users.lock: Permission denied`,
    ],
    [
      'in a home it may not write, with no locks directory',
      (home: string) => {
        fs.rmdirSync(locks(home));
        fs.chmodSync(home, 0o555);
      },
      (home: string) => `FileError: ${home}/locks: Permission denied`,
    ],
  ])(
    '%s raises what earlier releases raise',
    async (_label, shape, recorded) => {
      const before = process.env.HOUSTON_HOME;
      const home = fs.mkdtempSync(path.join(config.home(), 'shape-'));
      fs.mkdirSync(locks(home));
      process.env.HOUSTON_HOME = home;
      try {
        shape(home);
        let ours = 'added';
        try {
          await add('tsuser', GOOD, 'member');
        } catch (error) {
          ours = `${(error as Error).name}: ${(error as Error).message}`;
        }
        expect(ours).toBe(recorded(home));
      } finally {
        if (before === undefined) delete process.env.HOUSTON_HOME;
        else process.env.HOUSTON_HOME = before;
        fs.chmodSync(home, 0o700);
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe('names', () => {
  it.each([
    ['lucy.felix', 'lucy-felix'],
    ['Lucy.Felix', 'lucy-felix'],
    ['a b c', 'a-b-c'],
    ['--edge--', 'edge'],
    ['...', ''],
    ['', ''],
  ])('normalises %p to %p', (given, expected) => {
    expect(normalizeName(given)).toBe(expected);
  });

  it('normalises exactly as earlier releases do, character for character', () => {
    const names = [
      'lucy.felix',
      'Lucy.Felix',
      'a b c',
      '--edge--',
      '...',
      '',
      'a_b',
      'É.x',
      'x'.repeat(40),
    ];
    // What earlier releases made of each, recorded.
    const recorded = [
      'lucy-felix',
      'lucy-felix',
      'a-b-c',
      'edge',
      '',
      '',
      'a-b',
      'x',
      'x'.repeat(40),
    ];
    expect(names.map(normalizeName)).toEqual(recorded);
  });

  it('refuses an empty name and a too-long one with DIFFERENT sentences', () => {
    // The single combined message used to answer "at most 31 characters" to somebody
    // whose name was `...`, which names the wrong fix.
    expect(() => requireValidName('')).toThrow(/at least one letter or digit/u);
    expect(() => requireValidName('x'.repeat(32))).toThrow(/is 32 characters; the limit is 31/u);
    expect(() => requireValidName('-bad')).toThrow(/lowercase letters, digits and/u);
    expect(() => requireValidName('ok-name')).not.toThrow();
  });

  it('does not truncate a long name, because that silently rewrites an identity', () => {
    expect(normalizeName('x'.repeat(40))).toHaveLength(40);
  });

  it('raises ValidationError, which the front doors turn into a 400', () => {
    expect(() => requireValidName('')).toThrow(ValidationError);
    expect(() => requireValidPassword('short')).toThrow(ValidationError);
    expect(() => requireValidRole('wizard')).toThrow(ValidationError);
  });

  it('refuses a password below the floor and says how short it was', () => {
    expect(() => requireValidPassword('x'.repeat(MIN_PASSWORD - 1))).toThrow(
      `password must be at least ${MIN_PASSWORD} characters (got ${MIN_PASSWORD - 1})`,
    );
    expect(() => requireValidPassword('x'.repeat(MIN_PASSWORD))).not.toThrow();
  });

  // Earlier releases count code points and `String.length` counts UTF-16 units, so every
  // character outside the BMP counted twice: six emoji cleared the twelve-character floor
  // earlier releases refuse them at, and "(got N)" doubled.
  it('counts a password in code points, so an astral character is one, not two', async () => {
    const emoji = '\u{1F600}';
    const passwords = [
      emoji.repeat(6),
      emoji.repeat(5),
      'correcthor' + emoji,
      emoji.repeat(MIN_PASSWORD),
      'e\u0301'.repeat(6),
      '\ud800'.repeat(MIN_PASSWORD - 1),
      'x'.repeat(MIN_PASSWORD - 1),
    ];
    const answer = (check: () => void): string => {
      try {
        check();
        return 'ok';
      } catch (error) {
        return (error as Error).message;
      }
    };
    // What earlier releases answered for each, recorded.
    const floor = (got: number): string =>
      `password must be at least 12 characters (got ${String(got)})`;
    const expected = [floor(6), floor(5), floor(11), 'ok', 'ok', floor(11), floor(11)];
    expect(expected[0]).toBe('password must be at least 12 characters (got 6)');
    expect(passwords.map((p) => answer(() => requireValidPassword(p)))).toEqual(expected);
    // And the account is not made: the floor is the one `add` spends before hashing.
    await expect(add('bob', emoji.repeat(6))).rejects.toThrow(ValidationError);
    expect(anyUsers()).toBe(false);
  });

  it('counts a name in code points, for a caller that did not normalise it', () => {
    const emoji = '\u{1F600}';
    const names = [emoji.repeat(16), 'a' + emoji.repeat(30), 'x'.repeat(32), 'x'.repeat(31)];
    const answers = names.map((n) => {
      try {
        requireValidName(n);
        return 'ok';
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(answers).toEqual(RECORDED.nameAnswers);
  });
});

describe('roles', () => {
  it('reads a BLANK column as admin, which is the migration and not a default', () => {
    // Every account created before roles existed has an empty column. Reading blank as
    // anything narrower silently demotes every existing user, and on an install whose only
    // account predates the change it leaves the box with no admin at all.
    expect(normaliseRole('')).toBe(IMPLICIT_ADMIN);
    expect(normaliseRole('  ')).toBe('admin');
    expect(normaliseRole('wizard')).toBe('admin');
    expect(normaliseRole('READONLY')).toBe('readonly');
  });

  it('ranks admin over member over readonly, and refuses an unknown role outright', () => {
    expect(ROLES).toEqual(['admin', 'member', 'readonly']);
    expect(atLeast('admin', 'readonly')).toBe(true);
    expect(atLeast('member', 'admin')).toBe(false);
    expect(atLeast('readonly', 'readonly')).toBe(true);
    // Unknown on either side is false, which is what makes a missing account unable to act.
    expect(atLeast('', 'readonly')).toBe(false);
    expect(atLeast('admin', 'wizard')).toBe(false);
  });

  it('agrees with earlier releases about every rank pair, including the unknown ones', () => {
    const pairs = [
      ['admin', 'readonly'],
      ['member', 'admin'],
      ['readonly', 'readonly'],
      ['', 'readonly'],
      ['admin', 'wizard'],
      ['', ''],
    ];
    // What earlier releases answered for each pair, recorded.
    const recorded = [true, false, true, false, false, false];
    expect(recorded).toEqual(pairs.map(([a, b]) => atLeast(a as string, b as string)));
  });

  it('quotes an unknown role, and a refused name, as earlier releases quote them', () => {
    // Double quotes for a value holding a single one, and a
    // backslash or a tab escaped. These were wrapped in single quotes as they were, so
    // `users role bob "o'x"` said `unknown role 'o'x'`.
    const values = ["o'x", 'a\\b', 'x\ty', '"q"', 'both\'"', ''];
    const answer = (fn: (value: string) => void, value: string): string => {
      try {
        fn(value);
        return 'ok';
      } catch (error) {
        return (error as Error).message;
      }
    };
    // What earlier releases said for each, recorded.
    const recorded = RECORDED.quoting;
    expect(values.map((v) => [answer(requireValidRole, v), answer(requireValidName, v)])).toEqual(
      recorded,
    );
    expect(recorded[0]?.[0]).toBe('unknown role "o\'x" (want: admin, member, readonly)');
  });

  it('makes the FIRST account admin and every one after it a member', async () => {
    expect(defaultRoleForNewAccount()).toBe('admin');
    const first = await add('alice', GOOD);
    expect(first.role).toBe('admin');
    expect(defaultRoleForNewAccount()).toBe('member');
    expect((await add('bob', GOOD)).role).toBe('member');
  });

  it('writes an EXPLICIT role for a new account, never a blank column', async () => {
    await add('alice', GOOD);
    expect((rows()[0] as string).split(':')[3]).toBe('admin');
    expect(implicitAdmins()).toEqual([]);
  });

  it('names the accounts that are admin only because their column is blank', async () => {
    await add('alice', GOOD, 'admin');
    fs.appendFileSync(usersFile(), `legacy:${await hashPassword(GOOD)}:2024-01-01\n`);
    expect(implicitAdmins()).toEqual(['legacy']);
    expect(admins()).toEqual(['alice', 'legacy']);
    expect(roleOf('legacy')).toBe('admin');
  });
});

describe('the last admin', () => {
  it('cannot be removed, from either front end', async () => {
    await add('alice', GOOD, 'admin');
    await add('bob', GOOD, 'member');
    await expect(remove('alice')).rejects.toThrow(ConflictError);
    await expect(remove('alice')).rejects.toThrow(/only admin/u);
    expect(await remove('bob')).toBe(0);
  });

  it('cannot be demoted either, checked under the lock', async () => {
    await add('alice', GOOD, 'admin');
    await expect(setRole('alice', 'member')).rejects.toThrow(ConflictError);
    await add('bob', GOOD, 'admin');
    expect((await setRole('alice', 'member')).role).toBe('member');
  });

  it('may still be promoted, which is never the dangerous direction', async () => {
    await add('alice', GOOD, 'admin');
    expect((await setRole('alice', 'admin')).role).toBe('admin');
  });
});

describe('add, passwd, remove, role', () => {
  it('returns the name it really stored, not the one it was handed', async () => {
    const user = await add('Lucy.Felix', GOOD, 'member');
    expect(user.name).toBe('lucy-felix');
    expect(roleOf('Lucy.Felix')).toBe('member');
  });

  it('refuses a duplicate with the command that would change the password', async () => {
    await add('alice', GOOD);
    await expect(add('alice', GOOD)).rejects.toThrow(ConflictError);
    await expect(add('alice', GOOD)).rejects.toThrow(/houston users passwd alice/u);
  });

  it('raises NotFoundError for an account that is not there', async () => {
    await expect(setPassword('ghost', GOOD)).rejects.toThrow(NotFoundError);
    await expect(remove('ghost')).rejects.toThrow(NotFoundError);
    await expect(setRole('ghost', 'member')).rejects.toThrow(NotFoundError);
  });

  it('ends every live session when a password is replaced', async () => {
    // Changing a compromised password while the intruder stays signed in for seven days
    // is not a fix, and both front ends had to remember that separately before it moved
    // into the service.
    await add('alice', GOOD);
    const token = await createSession('alice');
    expect(await setPassword('alice', 'a different password')).toBe(1);
    resetCache();
    expect(await verifySession(token)).toBeNull();
    expect(await verify('alice', 'a different password')).toBe(true);
    expect(await verify('alice', GOOD)).toBe(false);
  });

  it('ends every live session when an account is removed', async () => {
    await add('alice', GOOD, 'admin');
    await add('bob', GOOD, 'member');
    await createSession('bob');
    await createSession('bob');
    expect(await remove('bob')).toBe(2);
  });

  it('keeps the created date when the password or role changes', async () => {
    const made = await add('alice', GOOD, 'admin');
    await add('bob', GOOD, 'admin');
    await setPassword('alice', 'another good password');
    await setRole('alice', 'member');
    expect(listUsers().find((u) => u.name === 'alice')?.createdAt).toBe(made.createdAt);
  });

  it('mints a password nobody typed, ~96 bits of it', () => {
    const minted = mintPassword();
    expect(minted).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(minted).toHaveLength(16);
    expect(mintPassword()).not.toBe(minted);
  });
});

describe('verification', () => {
  it('accepts the right password and refuses the wrong one', async () => {
    await add('alice', GOOD);
    expect(await verify('alice', GOOD)).toBe(true);
    expect(await verify('alice', 'not it at all')).toBe(false);
  });

  it('accepts the dotted spelling of a name stored with dashes', async () => {
    await add('lucy.felix', GOOD);
    expect(await verify('lucy.felix', GOOD)).toBe(true);
    expect(await verify('lucy-felix', GOOD)).toBe(true);
  });

  it('refuses an empty name without touching the file', async () => {
    expect(await verify('', GOOD)).toBe(false);
  });

  it('never refuses a CORRECT password, whatever has failed before it', async () => {
    // An earlier version consulted a lockout counter first, so every still-open tab
    // replaying the OLD credential on its four-second poll slid the window forward and
    // kept the account locked -- refusing the correct NEW password with it.
    await add('alice', GOOD);
    for (let i = 0; i < 12; i += 1) expect(await verify('alice', `wrong ${i}`)).toBe(false);
    expect(await verify('alice', GOOD)).toBe(true);
  });

  it('audits a failure as `attempt`/`denied`, with the name exactly as typed', async () => {
    await add('alice', GOOD);
    expect(await verify('Lucy.Felix', 'whatever')).toBe(false);
    const line = readAudit({ kind: 'signin' }).lines[0];
    // Audited RAW: normalising first would launder a probe for `Lucy.Felix` into a tidy
    // line about `lucy-felix`, and an invalid name is exactly the traffic worth seeing.
    expect(line?.actor).toBe('Lucy.Felix');
    expect(line?.origin).toBe('attempt');
    expect(line?.outcome).toBe('denied');
    expect(line?.label).toBe('local');
  });

  it('records the resolved client address when the web layer supplies one', async () => {
    expect(await verify('ghost', 'whatever', '10.0.0.7')).toBe(false);
    expect(readAudit({ kind: 'signin' }).lines[0]?.label).toBe('10.0.0.7');
  });

  it('audits account changes from the service, not from either front end', async () => {
    await add('alice', GOOD, 'admin');
    await add('bob', GOOD, 'member');
    await setRole('bob', 'readonly');
    await setPassword('bob', 'another good password');
    await remove('bob');
    expect(readAudit({ limit: 50 }).lines.map((r) => r.kind)).toEqual([
      'user-remove',
      'user-passwd',
      'user-role',
      'user-add',
      'user-add',
    ]);
  });
});

describe('the team-mode registry', () => {
  it('answers lib/teammode without it having to import this module', async () => {
    expect(teamMode()).toBe(false);
    await add('alice', GOOD);
    expect(teamMode()).toBe(true);
  });
});

describe('compatibility with the users file earlier releases wrote', () => {
  /** Write an accounts file an earlier release wrote, where it keeps one. */
  function writeRecorded(bytes: string): void {
    fs.mkdirSync(config.home(), { recursive: true });
    fs.writeFileSync(path.join(config.home(), 'users'), bytes, { encoding: 'utf8', mode: 0o600 });
  }

  it('signs in against an account an earlier release created', async () => {
    // What an earlier release wrote for `add("alice", GOOD, role="member")`, recorded.
    writeRecorded(RECORDED.aliceMember);
    expect(await verify('alice', GOOD)).toBe(true);
    expect(await verify('alice', 'wrong')).toBe(false);
    expect(roleOf('alice')).toBe('member');
    expect(listUsers()).toEqual([{ name: 'alice', createdAt: expect.any(String), role: 'member' }]);
  });

  it('creates an account an earlier release signs in against', async () => {
    await add('bob', GOOD, 'readonly');
    // The file an earlier release wrote for the same account, recorded: this build's is the
    // same but for the salted hash and the date, and its hash derives again to itself, as
    // an earlier release checks it.
    const mine = fs.readFileSync(path.join(config.home(), 'users'), 'utf8');
    expect(layout(mine)).toBe(layout(RECORDED.bobReadonly));
    const stored = (rows()[0] as string).split(':')[1] as string;
    const salt = Buffer.from(stored.split('$')[4] as string, 'base64');
    expect(await hashPassword(GOOD, salt)).toBe(stored);
    expect((rows()[0] as string).split(':')[3]).toBe('readonly');
  });

  it('rewrites a file an earlier release wrote to the identical bytes', async () => {
    // What an earlier release wrote for alice as admin, then bob as member, recorded.
    writeRecorded(RECORDED.aliceAdminBobMember);
    const before = body();
    expect(before).toBe(RECORDED.aliceAdminBobMember);
    // A role set to what it already is still rewrites the whole file.
    await setRole('bob', 'member');
    expect(body()).toBe(before);
  });

  it('leaves a file an earlier release rewrites to the identical bytes', async () => {
    await add('alice', GOOD, 'admin');
    await add('bob', GOOD, 'member');
    const before = body();
    // An earlier release rewrites the file from what it reads, in its own layout: the one
    // it wrote for the same two accounts, recorded, which this file matches but for each
    // hash and date.
    expect(layout(before)).toBe(layout(RECORDED.aliceAdminBobMember));
    expect(body()).toBe(before);
  });

  it('agrees about a legacy blank-role line written by either build', async () => {
    const hashed = await hashPassword(GOOD);
    fs.writeFileSync(
      usersFile(),
      '# houston GUI accounts. Managed by `houston users`.\n' +
        '# name:hash:created_at[:role]\n' +
        `legacy:${hashed}:2024-01-01\n`,
      { mode: 0o600 },
    );
    expect(roleOf('legacy')).toBe('admin');
    // The role and the implicit admins earlier releases read from this file, recorded.
    const recorded = { role: 'admin', implicit: ['legacy'] };
    expect({ role: roleOf('legacy'), implicit: implicitAdmins() }).toEqual(recorded);
  });
});

// --- the behaviours of the users file that the cases above do not assert -------------

describe('the users file, as a reader meets it', () => {
  it('never writes the password itself', async () => {
    await add('alice', GOOD);
    expect(body()).not.toContain(GOOD);
    expect(body()).toContain('scrypt$');
  });

  it('ignores a comment or a blank line', async () => {
    await add('alice', GOOD);
    fs.writeFileSync(usersFile(), `# a comment\n\n   \n${body()}`, 'utf8');
    expect(listUsers().map((u) => u.name)).toEqual(['alice']);
  });

  it('skips a malformed line rather than failing the whole file', async () => {
    await add('alice', GOOD);
    fs.appendFileSync(usersFile(), 'garbage-with-no-fields\n', 'utf8');
    expect(listUsers().map((u) => u.name)).toEqual(['alice']);
    expect(await verify('alice', GOOD)).toBe(true);
  });

  it('round-trips an explicit role column through a rewrite', async () => {
    await add('alice', GOOD, 'readonly');
    await add('bob', GOOD, 'admin');
    expect(Object.fromEntries(listUsers().map((u) => [u.name, u.role]))).toEqual({
      alice: 'readonly',
      bob: 'admin',
    });
  });
});

describe('names, through the account they become', () => {
  it('stores a normalised label rather than refusing the name', async () => {
    // `serve` refuses a network-reachable bind with no accounts, so `users add lucy.felix`
    // failing was the whole reason a box could not be brought up.
    await add('keeper', GOOD);
    for (const [typed, stored] of [
      ['Alice', 'alice'],
      ['al ice', 'al-ice'],
      ['alice.b', 'alice-b'],
      ['-alice', 'alice'],
      ['al_ice', 'al-ice'],
      ['Lucy.Felix', 'lucy-felix'],
      ['lovekesh.kumar', 'lovekesh-kumar'],
    ] as const) {
      expect({ typed, stored: (await add(typed, GOOD)).name }).toEqual({ typed, stored });
      expect(roleOf(stored)).not.toBe('');
      await remove(stored);
    }
    expect((await add('alice-2', GOOD)).name).toBe('alice-2');
  });

  it('normalises exactly as a workspace name is sanitised', () => {
    // A deliberate copy of `lifecycle.sanitize` -- users sits below lifecycle. This stops
    // the copy drifting: otherwise an account name no longer survives becoming a
    // workspace name.
    const { sanitize } = require('../../src/core/lifecycle/naming') as typeof NamingNS;
    for (const raw of [
      'lucy.felix',
      'Lucy.Felix',
      'lovekesh.kumar',
      'al_ice',
      '-alice-',
      'a..b',
      'a  b',
      'TICKET-1234',
      'alice',
      'ålice',
      'a.b_c d',
    ]) {
      expect({ raw, name: normalizeName(raw) }).toEqual({ raw, name: sanitize(raw) });
    }
  });

  it('is managed by the name as it was typed, for every operation', async () => {
    // Having `add` fold the dot while the others did not would hand every dotted account a
    // login it cannot use.
    await add('keeper', GOOD);
    expect((await add('lucy.felix', GOOD)).name).toBe('lucy-felix');
    expect(await verify('lucy.felix', 'wrong-password-entirely')).toBe(false);
    expect(roleOf('lucy.felix')).toBe(roleOf('lucy-felix'));
    expect(roleOf('lucy.felix')).not.toBe('');
    await setRole('lucy.felix', 'readonly');
    expect(roleOf('lucy-felix')).toBe('readonly');
    await setPassword('lucy.felix', 'another-good-password');
    expect(await verify('lucy.felix', 'another-good-password')).toBe(true);
    await remove('lucy.felix');
    expect(roleOf('lucy-felix')).toBe('');
  });
});

describe('credentials that change underneath', () => {
  it('stops verifying a removed account at once', async () => {
    await add('alice', GOOD);
    await add('bob', GOOD, 'admin');
    expect(await verify('alice', GOOD)).toBe(true);
    await remove('alice');
    expect(await verify('alice', GOOD)).toBe(false);
  });

  it('honours a removal made by another process, and ends its session with it', async () => {
    // Verifications used to be cached in the long-lived `serve`, so a `users remove` from a
    // terminal went on being honoured there for minutes. Edited here the way a separate
    // process would: straight into the file.
    await add('alice', GOOD);
    expect(await verify('alice', GOOD)).toBe(true);
    const token = await createSession('alice');
    expect(await verifySession(token)).not.toBeNull();
    const lines = body().split('\n');
    fs.writeFileSync(usersFile(), lines.filter((l) => !l.startsWith('alice:')).join('\n'));
    expect(await verify('alice', GOOD)).toBe(false);
    await revokeUser('alice');
    resetCache();
    expect(await verifySession(token)).toBeNull();
  });

  it('honours a password another process changed, at once', async () => {
    await add('alice', GOOD);
    expect(await verify('alice', GOOD)).toBe(true);
    const fresh = await hashPassword('brand-new-password');
    fs.writeFileSync(usersFile(), body().replace(/^alice:[^:]+:/mu, `alice:${fresh}:`), 'utf8');
    expect(await verify('alice', GOOD)).toBe(false);
    expect(await verify('alice', 'brand-new-password')).toBe(true);
  });

  it('does not treat a role change as a credential change', async () => {
    // The web guard reads the role live on every request, so a demotion is in force at
    // once; signing the person out on top of that is a front end's choice, not the
    // service's guarantee.
    await add('alice', GOOD, 'admin');
    await add('bob', GOOD, 'member');
    const token = await createSession('bob');
    await setRole('bob', 'readonly');
    resetCache();
    expect(await verifySession(token)).not.toBeNull();
    expect(roleOf('bob')).toBe('readonly');
  });

  it('keeps the untouched account signed in while another is invalidated', async () => {
    await add('alice', GOOD, 'admin');
    await add('bob', GOOD, 'member');
    const alice = await createSession('alice');
    expect(await setPassword('bob', 'a-brand-new-password')).toBe(0);
    await add('carol', GOOD, 'member');
    resetCache();
    expect(await verifySession(alice)).not.toBeNull();
  });
});

describe('roles, as they arrive from a CLI argument or a JSON body', () => {
  it('validates a role and tolerates its case and surrounding whitespace', async () => {
    await add('alice', GOOD, 'admin');
    await add('bob', GOOD, 'readonly');
    await setRole('bob', 'member');
    expect(roleOf('bob')).toBe('member');
    for (const bad of ['root', '', 'superuser', 'admin;member']) {
      await expect(setRole('bob', bad)).rejects.toThrow(ValidationError);
    }
    // Rejecting " Admin" from a CLI argument or a JSON body would be pedantry.
    await setRole('bob', '  ReadOnly ');
    expect(roleOf('bob')).toBe('readonly');
  });
});

describe('sign-in, as the log and the clock see it', () => {
  it('records nothing for a successful sign-in', async () => {
    // Only failures: a line per success would double every sign-in and bury the ones
    // worth seeing.
    await add('alice', GOOD);
    expect(await verify('alice', GOOD, '10.0.0.4')).toBe(true);
    expect(readAudit({ kind: 'signin' }).lines).toEqual([]);
  });

  it('cannot let a hostile name forge an audit line', async () => {
    // The name reaches the log before any validation -- an invalid name is exactly the
    // traffic worth seeing -- so the FIELD has to be safe.
    await verify(
      'evil\tadmin\tuser-add\tbackdoor\tsession\tok\nnext-line',
      'wrong-password-x',
      '203.0.113.9',
    );
    const text = fs.readFileSync(path.join(config.home(), 'audit.log'), 'utf8');
    expect(text.split('\n').filter((l) => l !== '')).toHaveLength(1);
    const lines = readAudit({ kind: 'signin' }).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]?.actor).not.toContain('\t');
    expect([lines[0]?.outcome, lines[0]?.origin]).toEqual(['denied', 'attempt']);
  });

  it('refuses an empty password as it refuses an empty name', async () => {
    await add('alice', GOOD);
    expect(await verify('', GOOD)).toBe(false);
    expect(await verify('alice', '')).toBe(false);
  });

  it('hashes the same password differently each time', async () => {
    // Per-user salt: identical passwords must not produce identical lines.
    const [a, b] = [await hashPassword(GOOD), await hashPassword(GOOD)];
    expect(a).not.toBe(b);
    expect([await check(GOOD, a), await check(GOOD, b)]).toEqual([true, true]);
  });
});

describe('the work an unknown name costs', () => {
  afterEach(() => {
    jest.dontMock('node:crypto');
    jest.resetModules();
  });

  it('derives scrypt exactly once, known or unknown, and never zero times', async () => {
    // Returning early would let response time enumerate who exists; building the dummy
    // with `hashPassword` derived TWICE (measured 46.6 ms unknown vs 23.7 ms known).
    // Counted, not timed: a wall-clock assertion on a shared CI box is a flake.
    const calls = { n: 0 };
    jest.resetModules();
    jest.doMock('node:crypto', () => {
      const actual = jest.requireActual<typeof CryptoNS>('node:crypto');
      return {
        ...actual,
        scrypt: (...args: Parameters<typeof actual.scrypt>) => {
          calls.n += 1;
          return actual.scrypt(...args);
        },
      };
    });
    const fresh = require('../../src/core/users') as typeof UsersNS;
    await fresh.add('alice', GOOD);
    calls.n = 0;
    expect(await fresh.verify('alice', 'not-the-right-password')).toBe(false);
    const known = calls.n;
    calls.n = 0;
    expect(await fresh.verify('no-such-person', 'not-the-right-password')).toBe(false);
    expect({ known, unknown: calls.n }).toEqual({ known: 1, unknown: 1 });
  });
});

describe('concurrent writers', () => {
  it('loses no account when eight adds race in one process', async () => {
    // Every mutation is read-whole-file -> change -> rewrite, so without exclusion a later
    // write is based on a snapshot taken before the earlier one landed.
    const names = [...Array(8).keys()].map((i) => `racer${String(i)}`);
    await Promise.all(names.map((name) => add(name, GOOD, 'member')));
    expect(listUsers().map((u) => u.name)).toEqual(names);
  });

  it('loses no account when the other build adds at the same moment', async () => {
    // The race across PROCESSES is the one that actually happens: `serve` writes this file
    // while somebody runs `houston users add` in a terminal. Four other processes add an
    // account the way earlier releases do -- under an exclusive flock(2) on
    // `locks/users.lock`, taken here through flock(1), they read the file, add the line an
    // earlier release wrote for that account (recorded), and replace the file with the
    // header and every account in name order -- while four adds run here, all at once:
    // the cross-implementation half of the lock.
    const lockDir = path.join(config.home(), 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const script =
      'umask 077; f="$1"; tmp="$f.$$.tmp"; ' +
      '{ printf "%s\\n" "# houston GUI accounts. Managed by \\`houston users\\`." ' +
      '"# name:hash:created_at[:role]"; ' +
      '{ if [ -f "$f" ]; then grep -v "^#" "$f" | grep -v "^$"; fi; printf "%s\\n" "$2"; } ' +
      '| LC_ALL=C sort -t: -k1,1; } > "$tmp" && mv "$tmp" "$f"';
    const children = RECORDED.concurrentLines.map(
      (line) =>
        new Promise<number>((resolve) => {
          const child = spawn(
            'flock',
            ['-x', path.join(lockDir, 'users.lock'), 'sh', '-c', script, 'sh', usersFile(), line],
            { stdio: 'ignore' },
          );
          child.on('exit', (code) => resolve(code ?? -1));
        }),
    );
    const ours = [...Array(4).keys()].map((i) => add(`node${String(i)}`, GOOD, 'member'));
    expect(await Promise.all(children)).toEqual([0, 0, 0, 0]);
    await Promise.all(ours);
    expect(listUsers().map((u) => u.name)).toEqual([
      'node0',
      'node1',
      'node2',
      'node3',
      'proc0',
      'proc1',
      'proc2',
      'proc3',
    ]);
  });
});
