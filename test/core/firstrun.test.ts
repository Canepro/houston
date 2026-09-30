import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../src/lib/config';

import {
  FIRST_RUN_FILE,
  TTL_SECONDS,
  consume,
  keyPath,
  mint,
  valid,
} from '../../src/core/firstrun';

/**
 * A key an earlier release minted, and the file it wrote for it, recorded byte for byte.
 * The key is only good inside its fifteen minutes, so a test that reads it sets the clock
 * to a minute after RECORDED_MINTED.
 */
const RECORDED_KEY = '7VEQ0hdgWCWIycqWbt6M-BQ5NYInpDAQ';
const RECORDED_DIGEST = 'e8a8153253fc7b52b27ab6f98b5ef25f03a9978b09e20499875a3a950939d868';
const RECORDED_MINTED = 1790671475;
const RECORDED_HEADER =
  '# houston first-run key. Single use, 15 minutes.\n# sha256(key)\tminted\texpires\n';
const RECORDED_BODY = `${RECORDED_HEADER}${RECORDED_DIGEST}\t1790671475\t1790672375\n`;
/** The name earlier releases gave the file, under HOUSTON_HOME. */
const RECORDED_FILE_NAME = 'first-run';

/** Where an earlier release reads and writes the key, and what it wrote there. */
function writeRecorded(): string {
  const file = path.join(config.home(), RECORDED_FILE_NAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, RECORDED_BODY, { encoding: 'utf8', mode: 0o600 });
  jest.spyOn(Date, 'now').mockReturnValue((RECORDED_MINTED + 60) * 1000);
  return file;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function body(): string {
  return fs.readFileSync(keyPath(), 'utf8');
}

function row(): string[] {
  return (
    body()
      .split('\n')
      .find((line) => line !== '' && !line.startsWith('#')) ?? ''
  ).split('\t');
}

beforeEach(() => {
  fs.rmSync(keyPath(), { force: true });
});

describe('the minted key', () => {
  it('is 24 random bytes as unpadded base64url, as earlier releases mint it', () => {
    const key = mint();
    expect(key).toHaveLength(32);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(mint()).not.toBe(key);
  });

  it('puts only the sha256 on disk, never the key', () => {
    const key = mint();
    expect(body()).not.toContain(key);
    expect(row()[0]).toBe(sha256(key));
  });

  it('writes the two header lines and one tab-separated row', () => {
    mint();
    const lines = body().split('\n');
    expect(lines[0]).toBe('# houston first-run key. Single use, 15 minutes.');
    expect(lines[1]).toBe('# sha256(key)\tminted\texpires');
    expect(row()).toHaveLength(3);
  });

  it('expires fifteen minutes after it was minted', () => {
    mint();
    const [, minted, expires] = row();
    expect(Number(expires) - Number(minted)).toBe(TTL_SECONDS);
    expect(TTL_SECONDS).toBe(15 * 60);
  });

  it('is created 0600, because it is a credential', () => {
    mint();
    expect(fs.statSync(keyPath()).mode & 0o777).toBe(0o600);
  });

  it('supersedes the previous one, because a hashed key cannot be reprinted', () => {
    // Every `serve` mints fresh. Reporting an outstanding key instead cannot be done:
    // only the sha256 reaches disk, and a key that cannot be read back cannot be
    // reprinted. So the URL just printed is always the one that works.
    const first = mint();
    const second = mint();
    expect(valid(first)).toBe(false);
    expect(valid(second)).toBe(true);
  });
});

describe('validation', () => {
  it('accepts the outstanding key and nothing else', () => {
    const key = mint();
    expect(valid(key)).toBe(true);
    expect(valid('')).toBe(false);
    expect(valid('not-the-key')).toBe(false);
    // A same-length wrong key exercises the constant-time compare rather than the
    // length guard in front of it.
    expect(valid('x'.repeat(key.length))).toBe(false);
  });

  it('refuses when there is no key at all', () => {
    expect(valid('anything')).toBe(false);
  });

  it('refuses an expired key without needing anything to sweep it', () => {
    const key = mint();
    const expired = body().replace(/\t(\d+)\t(\d+)\n/u, '\t1000000\t1000060\n');
    fs.writeFileSync(keyPath(), expired);
    expect(valid(key)).toBe(false);
  });

  it('refuses a corrupt file rather than throwing out of the sign-in path', () => {
    for (const junk of ['', '# only a comment\n', 'not\ttabs\n', 'a\tb\tnotanumber\n']) {
      fs.writeFileSync(keyPath(), junk);
      expect(valid('anything')).toBe(false);
    }
  });
});

describe('consume', () => {
  it('burns the key so it cannot be replayed', () => {
    const key = mint();
    consume();
    expect(fs.existsSync(keyPath())).toBe(false);
    expect(valid(key)).toBe(false);
  });

  it('is silent when there is nothing to burn', () => {
    expect(() => consume()).not.toThrow();
  });
});

describe('compatibility with the key file earlier releases wrote', () => {
  it('validates a key an earlier release minted', () => {
    writeRecorded();
    expect(valid(RECORDED_KEY)).toBe(true);
    expect(valid(`${RECORDED_KEY}x`)).toBe(false);
  });

  it('mints a key an earlier release validates', () => {
    // An earlier release reads the first row that is not a comment: the digest, then the
    // expiry as a whole number of seconds. This build's file is the recorded one with its
    // own digest and times in their places, so it reads it as it reads its own and answers
    // as recorded: the key is good and "wrong" is not.
    const key = mint();
    const minted = Number(row()[1]);
    expect(Number.isInteger(minted)).toBe(true);
    const expected = RECORDED_BODY.replace(RECORDED_DIGEST, sha256(key)).replace(
      `\t${String(RECORDED_MINTED)}\t${String(RECORDED_MINTED + TTL_SECONDS)}\n`,
      `\t${String(minted)}\t${String(minted + TTL_SECONDS)}\n`,
    );
    expect(body()).toBe(expected);
    expect(fs.readFileSync(path.join(config.home(), RECORDED_FILE_NAME), 'utf8')).toBe(expected);
    expect([valid(key), valid('wrong')]).toEqual([true, false]);
  });

  it('has its consume honoured by the other build, and vice versa', () => {
    // An earlier release's consume removes `<home>/first-run`, so its own check answers
    // no afterwards, and this build must too.
    const key = mint();
    fs.rmSync(path.join(config.home(), RECORDED_FILE_NAME), { force: true });
    expect(valid(key)).toBe(false);

    // And this build's consume removes the file an earlier release minted, which is the
    // only way its check answers no to a key still inside its fifteen minutes.
    const file = writeRecorded();
    expect(valid(RECORDED_KEY)).toBe(true);
    consume();
    expect(fs.existsSync(file)).toBe(false);
    expect(valid(RECORDED_KEY)).toBe(false);
  });

  it('writes the same file name and the same header bytes', () => {
    mint();
    const mine = body().split('\n').slice(0, 2).join('\n');
    expect(`${mine}\n`).toBe(RECORDED_HEADER);
    expect(FIRST_RUN_FILE).toBe(RECORDED_FILE_NAME);
  });
});
