import * as fs from 'node:fs';
import * as path from 'node:path';

import { STRIP_CHARS } from '../../src/lib/float-text';
import {
  REDACTED,
  SECRET_KEY_HINTS,
  URL_USERINFO,
  redactArgv,
  redactEnv,
} from '../../src/lib/redact';

/** What earlier releases' redactor returned for the larger corpora below, recorded. */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'lib', 'redact.json'), 'utf8'),
) as { mongo_url_redacted: string[] };

/**
 * Every code point the userinfo pattern's `\s` matches in earlier releases, recorded by
 * measuring all of them: the ASCII controls 0x09-0x0d, the separators 0x1c-0x1f, space,
 * NEL, no-break space, and the Unicode space separators -- and not the BOM.
 */
const RECORDED_WHITESPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000,
];

/**
 * The pairs that matter, including the ones that must NOT be masked.
 *
 * A redactor tested only on things it should hide proves nothing about the far more
 * common case -- an ordinary value it must leave alone, because a log full of `********`
 * is a log nobody can read.
 */
const CASES: [string, string][] = [
  ['LDAP_BIND_PASSWORD', 'hunter2'],
  ['ADMIN_PASS', 'hunter2'],
  ['OAUTH_SECRET', 'sh'],
  ['REG_TOKEN', 't'],
  ['TLS_KEY', 'k'],
  ['API_KEY', 'k'],
  ['MY_APIKEY', 'k'],
  ['SOME_CREDENTIAL', 'c'],
  // Not credentials, and a redactor that masks these is useless.
  ['ROOT_URL', 'http://localhost:3000'],
  ['MONGO_TAG', '8.0'],
  ['PORT', '3000'],
  // The credential the KEY NAME never reveals.
  ['MONGO_URL', 'mongodb://rc:s3cret@mongo:27017/rocketchat?replicaSet=rs0'],
  ['MONGO_OPLOG_URL', 'mongodb://rc:s3cret@mongo:27017/local'],
  ['TWO_URLS', 'a://u:p@h1 b://u2:p2@h2'],
  // Shapes that look like userinfo and are not.
  ['NO_USERINFO', 'https://example.com/a:b@c'],
  ['EMPTY', ''],
  ['NOT_A_URL', 'rc:s3cret@mongo'],
];

describe('redactEnv', () => {
  it('masks a value whose key names a credential', () => {
    expect(redactEnv('LDAP_BIND_PASSWORD', 'hunter2')).toBe(REDACTED);
    expect(redactEnv('API_KEY', 'k')).toBe(REDACTED);
  });

  it('leaves an ordinary value alone, which is the common case', () => {
    expect(redactEnv('ROOT_URL', 'http://localhost:3000')).toBe('http://localhost:3000');
    expect(redactEnv('MONGO_TAG', '8.0')).toBe('8.0');
  });

  it('masks a credential embedded in URL userinfo, whatever the key is called', () => {
    // `MONGO_URL` reveals nothing about the password inside it, so this has to inspect
    // the VALUE.
    expect(redactEnv('MONGO_URL', 'mongodb://rc:s3cret@mongo:27017/rocketchat')).toBe(
      `mongodb://rc:${REDACTED}@mongo:27017/rocketchat`,
    );
  });

  it('masks EVERY userinfo in a value, not just the first', () => {
    expect(redactEnv('TWO', 'a://u:p@h1 b://u2:p2@h2')).toBe(
      `a://u:${REDACTED}@h1 b://u2:${REDACTED}@h2`,
    );
  });

  it('does not mask an empty value even when the key names a credential', () => {
    // Only a non-empty value is ever masked: an empty string stays empty rather than
    // becoming a mask that implies a secret is set.
    expect(redactEnv('LDAP_BIND_PASSWORD', '')).toBe('');
  });

  it('is the same rule earlier releases apply, for every pair', () => {
    // One recorded answer per CASES entry, in order.
    const recorded = [
      ...Array<string>(8).fill('********'),
      'http://localhost:3000',
      '8.0',
      '3000',
      'mongodb://rc:********@mongo:27017/rocketchat?replicaSet=rs0',
      'mongodb://rc:********@mongo:27017/local',
      'a://u:********@h1 b://u2:********@h2',
      'https://example.com/a:b@c',
      '',
      'rc:s3cret@mongo',
    ];
    expect(CASES.map(([k, v]) => redactEnv(k, v))).toEqual(recorded);
  });

  it('declares the hints and the mask of earlier releases, plus the licence', () => {
    // `rocketchat_license` is the one deliberate addition: earlier releases printed an
    // Enterprise licence wherever they printed env, and `up --license` exists to keep it out.
    const recorded = {
      hints: ['password', 'pass', 'secret', 'token', '_key', 'apikey', 'credential'],
      redacted: '********',
    };
    expect([...recorded.hints, 'rocketchat_license']).toEqual([...SECRET_KEY_HINTS]);
    expect(redactEnv('ROCKETCHAT_LICENSE', 'RCV3_abc')).toBe(REDACTED);
    expect(recorded.redacted).toBe(REDACTED);
  });

  it('matches the same substrings the earlier pattern matches, on a corpus', () => {
    // The pattern is TRANSCRIBED, so it has to be checked -- but not by comparing source
    // text. `[a-zA-Z0-9+.\\-]` and `[a-zA-Z0-9+.-]` are the same character class spelled
    // two ways, and a test that compares spelling fails on a lint fix while a genuine
    // change of meaning could still slip past. So compare what the two actually MATCH.
    const corpus = [
      'mongodb://rc:s3cret@mongo:27017/rocketchat',
      'https://user:pw@example.com/path',
      'a://u:p@h1 b://u2:p2@h2',
      'https://example.com/a:b@c',
      'rc:s3cret@mongo',
      'ldaps://cn=admin:pw@dc.example.com',
      'x+y-z.1://u:p@h',
      '://u:p@h',
      'http://nopassword@host',
      '',
    ];
    // What earlier releases' pattern made of each corpus entry, with `<M>` for a match.
    const recorded = [
      '<M>mongo:27017/rocketchat',
      '<M>example.com/path',
      '<M>h1 <M>h2',
      'https://example.com/a:b@c',
      'rc:s3cret@mongo',
      '<M>dc.example.com',
      '<M>h',
      '://u:p@h',
      'http://nopassword@host',
      '',
    ];
    expect(corpus.map((c) => c.replace(URL_USERINFO, '<M>'))).toEqual(recorded);
  });
});

describe('redactArgv', () => {
  it('masks the registration token in either spelling', () => {
    expect(redactArgv(['up', '--reg-token', 'abc', '--reg-token=def'])).toEqual([
      'up',
      '--reg-token',
      REDACTED,
      `--reg-token=${REDACTED}`,
    ]);
  });

  it('masks a KEY=VALUE value by its key, and leaves an ordinary one readable', () => {
    expect(
      redactArgv([
        '--setting',
        'LDAP_Authentication_Password=hunter2',
        '--setting=Site_Name=Acme',
        '--env',
        'ADMIN_PASS=x',
        '-e',
        'PORT=3000',
        '-eAPI_KEY=k',
        '--set',
        'bind_password=y',
        '--set=users=5',
      ]),
    ).toEqual([
      '--setting',
      `LDAP_Authentication_Password=${REDACTED}`,
      '--setting=Site_Name=Acme',
      '--env',
      `ADMIN_PASS=${REDACTED}`,
      '-e',
      'PORT=3000',
      `-eAPI_KEY=${REDACTED}`,
      '--set',
      `bind_password=${REDACTED}`,
      '--set=users=5',
    ]);
  });

  it('masks URL userinfo in any token, whatever flag carries it', () => {
    expect(
      redactArgv([
        '--env',
        'MONGO_URL=mongodb://rc:s3@h/db',
        '--root-url=https://u:p@h',
        'a://u:p@h',
      ]),
    ).toEqual([
      '--env',
      `MONGO_URL=mongodb://rc:${REDACTED}@h/db`,
      `--root-url=https://u:${REDACTED}@h`,
      `a://u:${REDACTED}@h`,
    ]);
  });

  it('leaves a command line with no credential byte-identical', () => {
    const argv = ['up', '--version', '8.5.1', '--name', 'TICKET-1', '--preset', 'ldap', '--wait'];
    expect(redactArgv(argv)).toEqual(argv);
  });
});

describe("the userinfo pattern's whitespace", () => {
  // `[^/\s@]` decides where a password ENDS, and `\s` is not one set everywhere:
  // JavaScript's holds the BOM and not `\x1c`-`\x1f` or NEL, earlier releases' the
  // reverse. Written with JavaScript's, a `MONGO_URL` password holding a BOM was masked by
  // earlier releases and printed in the clear by `env` here.

  it("is built from the set earlier releases' \\s matches, measured over every code point", () => {
    // `STRIP_CHARS` is the whitespace set earlier releases strip with; their pattern's `\s`
    // is the same set, and the recorded measurement is what says so rather than the claim.
    const ours = [...STRIP_CHARS].map((c) => c.codePointAt(0) ?? -1).sort((a, b) => a - b);
    expect(ours).toEqual(RECORDED_WHITESPACE);
  });

  it('leaves a URL credential unmasked at exactly the code points earlier releases do', () => {
    // Every code point, in the user half and in the password half. A character the
    // pattern treats as whitespace ends the userinfo, so the URL is not masked; any other
    // is part of the credential and is.
    const unmasked = (make: (ch: string) => string, sub: (s: string) => string): number[] => {
      const out: number[] = [];
      for (let point = 0; point <= 0x10ffff; point += 1) {
        if (sub(make(String.fromCodePoint(point))) !== '<M>h') out.push(point);
      }
      return out;
    };
    // Recorded over every code point, in both halves: the whitespace set, plus `/` and `@`.
    const unmaskedAt = [...RECORDED_WHITESPACE, 0x2f, 0x40].sort((a, b) => a - b);
    const recorded = [unmaskedAt, unmaskedAt];
    const sub = (s: string) => s.replace(URL_USERINFO, '<M>');
    expect([
      unmasked((ch) => `a://u:p${ch}w@h`, sub),
      unmasked((ch) => `a://u${ch}x:p@h`, sub),
    ]).toEqual(recorded);
  });

  it('masks a MONGO_URL password holding each whitespace-like character as earlier releases do', () => {
    // Everything JavaScript or earlier releases call whitespace, plus the format characters
    // that look like it and are whitespace to neither -- at the start, middle and end of a password,
    // and inside the user name.
    const chars = [
      ...'\t\n\v\f\r \u001c\u001d\u001e\u001f\u0085\u00a0\u1680\u2000\u2001\u2002\u2003',
      ...'\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
      ...'\u180e\u200b\u200c\u200d\u2060\ufffe\u0000\u007f',
    ];
    const values: string[] = [];
    for (const ch of chars) {
      for (const pw of [`p${ch}w`, `${ch}pw`, `pw${ch}`]) values.push(`mongodb://u:${pw}@h/db`);
      values.push(`mongodb://u${ch}x:pw@h/db`);
    }
    expect(values.map((v) => redactEnv('MONGO_URL', v))).toEqual(RECORDED.mongo_url_redacted);
    // The finding's own value, by name: a BOM inside the password is masked.
    expect(redactEnv('MONGO_URL', 'mongodb://u:p\ufeffw@h/db')).toBe(
      `mongodb://u:${REDACTED}@h/db`,
    );
  });
});
