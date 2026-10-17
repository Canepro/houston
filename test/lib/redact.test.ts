import * as fs from 'node:fs';
import * as path from 'node:path';

import { STRIP_CHARS } from '../../src/lib/float-text';
import {
  REDACTED,
  SECRET_KEY_HINTS,
  URL_USERINFO,
  redactAllUserinfo,
  redactAssignedText,
  credentialFlag,
  redactArgv,
  redactEnv,
} from '../../src/lib/redact';
import { assertProtectedFragmentsWithheld } from '../fixtures/lib/protected-fragments';

/** What earlier releases' redactor returned for the larger corpora below, recorded. */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'lib', 'redact.json'), 'utf8'),
) as { mongo_url_redacted: string[] };

/**
 * A pinned, finite snapshot from the merged workbench-v2 head. The fixture names its exact
 * coverage and limits: it protects previously masked bytes from becoming readable, rather than
 * claiming that the rows exhaust every spelling a redactor can encounter.
 */
const MASKING_BASELINE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'lib', 'masking-baseline.json'), 'utf8'),
) as {
  base: string;
  scope: string[];
  limits: string[];
  public: [string, string, string[]][];
};

function redactBaselineRow(kind: string, input: string): string {
  switch (kind) {
    case 'assigned':
      return redactAssignedText(input);
    case 'userinfo':
      return redactAllUserinfo(input);
    case 'env': {
      const [key = '', value = ''] = input.split('\0');
      return `${key}\0${redactEnv(key, value)}`;
    }
    case 'argv':
      return redactArgv(input.split('\0')).join('\0');
    default:
      throw new Error(`unknown masking baseline row '${kind}'`);
  }
}

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

describe('the pinned masking baseline', () => {
  it('uses unique public-redaction markers', () => {
    const markers = MASKING_BASELINE.public.flatMap(([, , protectedMarkers]) => protectedMarkers);
    expect(new Set(markers).size).toBe(markers.length);
  });

  it('keeps every finite cd43ec6 public-redaction marker and meaningful fragment non-readable', () => {
    expect(MASKING_BASELINE.base).toBe('cd43ec601791a7cdf510bfaa9c0a6d4e935e7f03');
    for (const [kind, input, protectedMarkers] of MASKING_BASELINE.public) {
      const output = redactBaselineRow(kind, input);
      assertProtectedFragmentsWithheld(output, protectedMarkers);
      for (const marker of protectedMarkers) {
        expect(() => assertProtectedFragmentsWithheld(marker.slice(0, -1), [marker])).toThrow(
          'protected marker fragment',
        );
        const middle = Math.floor(marker.length / 2);
        const altered = `${marker.slice(0, middle)}!${marker.slice(middle + 1)}`;
        expect(() => assertProtectedFragmentsWithheld(altered, [marker])).toThrow(
          'protected marker fragment',
        );
      }
    }
  });
});

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
    expect([
      redactEnv('MONGO_URL', 'mongodb://rc:s3cret@mongo:27017/rocketchat'),
      redactEnv('URL', 'https://:EmptyUserPasswordSentinel@example.test/?q=a=b'),
      redactEnv('URL', 'https://reader:Raw@AtPasswordSentinel@example.test/?q=a=b'),
      redactEnv('URL', 'https://reader:password@example.test/?notify=@support'),
    ]).toEqual([
      `mongodb://rc:${REDACTED}@mongo:27017/rocketchat`,
      `https://:${REDACTED}@example.test/?q=a=b`,
      `https://reader:${REDACTED}@example.test/?q=a=b`,
      `https://reader:${REDACTED}@example.test/?notify=@support`,
    ]);
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

  it('matches complete passwords inside URL authorities on a corpus', () => {
    // Compare what the matcher actually finds rather than its spelling. A raw `@` remains
    // part of a valid password until the final authority delimiter, and an empty username
    // does not make a following password safe to print.
    const corpus = [
      'mongodb://rc:s3cret@mongo:27017/rocketchat',
      'https://user:pw@example.com/path',
      'a://u:p@h1 b://u2:p2@h2',
      'https://:empty-user-password@example.com/path',
      'https://user:raw@at@example.com/path',
      'https://example.com/a:b@c',
      'rc:s3cret@mongo',
      'ldaps://cn=admin:pw@dc.example.com',
      'x+y-z.1://u:p@h',
      '://u:p@h',
      'http://nopassword@host',
      '',
    ];
    const recorded = [
      '<M>mongo:27017/rocketchat',
      '<M>example.com/path',
      '<M>h1 <M>h2',
      '<M>example.com/path',
      '<M>example.com/path',
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

describe('redactAllUserinfo', () => {
  it('masks the whole URL user info an attachable bundle cannot assume is public', () => {
    const masked = (value: string) => redactAllUserinfo(value);
    expect(
      [
        '{"url":"https://idp.example","admin":"ops@example.com"}',
        '["https://a.example","ops@example.com"]',
        'https://BEARER_TOKEN@example.test/x',
        'https://TOKEN:@h',
        'https://ghp_SECRETTOKEN:x-oauth-basic@github.com/org/repo.git',
        'https://user:pw@h',
        'https://a@b@h/p',
        'https://example.com/a@b',
        'https://example.com?next=a@b',
        'mongodb://rc:s3cret@mongo:27017/db',
        'https://:pw@h',
        'https://@h',
        'x https://t@h y https://u:p@h2',
        // Characters a URL parser accepts raw in user info, and percent-encodes.
        'mongodb://rc:p{a}ss@mongo/rc',
        'mongodb://rc:Pa^ss|w0rd@mongo/rc',
        'https://u:p`x@h',
        'https://u:a\\b@h',
        'https://u:p"q@h',
        'https://u:p<q>[r]@h/p?q=a@b',
        'https://TOK{EN@h/x',
        'mongodb://rc:p{w@[::1]:27017/rc',
        // JSON is masked string by string, so one string's URL cannot reach into the next.
        '{"url":"https://u:p{a}\\"q@idp/x","admin":"ops@example.com"}',
        '{ "a": "\\u00e9",\n  "u": "https://T|K@h", "n": 1 }',
        '{"cfg":"{\\"url\\":\\"https://idp.example\\",\\"admin\\":\\"ops@example.com\\"}"}',
        '{"cfg":"{\\"url\\":\\"https://u:p{a}@idp\\"}"}',
        'OIDC={"url":"https://idp.example","admin":"ops@example.com"}',
        'OIDC={"url":"https://u:p^q@idp","admin":"ops@example.com"}',
        'https://u:p=["x"]@h',
      ].map(masked),
    ).toEqual([
      '{"url":"https://idp.example","admin":"ops@example.com"}',
      '["https://a.example","ops@example.com"]',
      `https://${REDACTED}@example.test/x`,
      `https://${REDACTED}@h`,
      `https://${REDACTED}@github.com/org/repo.git`,
      `https://${REDACTED}@h`,
      `https://${REDACTED}@h/p`,
      'https://example.com/a@b',
      'https://example.com?next=a@b',
      `mongodb://${REDACTED}@mongo:27017/db`,
      `https://${REDACTED}@h`,
      'https://@h',
      `x https://${REDACTED}@h y https://${REDACTED}@h2`,
      `mongodb://${REDACTED}@mongo/rc`,
      `mongodb://${REDACTED}@mongo/rc`,
      `https://${REDACTED}@h`,
      `https://${REDACTED}@h`,
      `https://${REDACTED}@h`,
      `https://${REDACTED}@h/p?q=a@b`,
      `https://${REDACTED}@h/x`,
      `mongodb://${REDACTED}@[::1]:27017/rc`,
      `{"url":"https://${REDACTED}@idp/x","admin":"ops@example.com"}`,
      `{ "a": "\\u00e9",\n  "u": "https://${REDACTED}@h", "n": 1 }`,
      '{"cfg":"{\\"url\\":\\"https://idp.example\\",\\"admin\\":\\"ops@example.com\\"}"}',
      `{"cfg":"{\\"url\\":\\"https://${REDACTED}@idp\\"}"}`,
      'OIDC={"url":"https://idp.example","admin":"ops@example.com"}',
      `OIDC={"url":"https://${REDACTED}@idp","admin":"ops@example.com"}`,
      `https://${REDACTED}@h`,
    ]);
  });
});

describe('credentialFlag', () => {
  it('names credential option words and leaves lookalikes readable', () => {
    const credentials = [
      '--requirepass',
      '-storepass',
      '-keypass',
      '--sslpass',
      '--password1',
      '--password2',
      '--secretvalue',
      '-passin',
      '--secretkey',
      '--dbpass',
      '--passcode',
      '--password',
      '--db2pass',
      '--mysql8pass',
      '--s3pass',
      '--db2password',
      '--apikeyvalue',
      '--sshkeydata',
      '--installpassword',
      '--installpass',
      '--sanopass',
      '--pass2word',
      '--passw0rd',
      '--oauth2-bearer',
      '--api-key',
      '--client-key',
    ];
    const readable = [
      '--bypass',
      '--compass',
      '--proxy-bypass-list',
      '--port',
      '--passive',
      '--passthrough',
      '--proxybypass',
      '--sslbypass',
      '--nopass',
      '--skippass',
      '--lowpass',
      '--bypassfile',
      '--sort-keys',
      '--primary-key',
    ];
    expect([...credentials, ...readable].filter(credentialFlag)).toEqual(credentials);
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
  // Whitespace ends a URL authority, and `\s` is not one set everywhere: JavaScript's holds
  // the BOM and not `\x1c`-`\x1f` or NEL, earlier releases' the reverse. Written with
  // JavaScript's, a `MONGO_URL` password holding a BOM was masked by earlier releases and
  // printed in the clear by `env` here.

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
    // URL authority ends at whitespace, `/`, `?`, or `#`. A raw `@` before the final
    // delimiter stays part of valid userinfo and must be masked.
    const unmaskedAt = [...RECORDED_WHITESPACE, 0x23, 0x2f, 0x3f].sort((a, b) => a - b);
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
