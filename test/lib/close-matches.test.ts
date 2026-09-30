/**
 * `getCloseMatches` against the answers earlier releases gave, on the same inputs.
 *
 * The suggestions a usage error prints come from here, so they are held to what earlier
 * releases printed rather than a list of expected answers written by hand: the corpus is
 * every long option and command name houston had when the answers were recorded, typos of
 * them, and shapes chosen to reach each branch -- ties broken by the candidate, repeated
 * elements the quick ratio must count, and a word long enough for the junk heuristic.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { SequenceMatcher, getCloseMatches } from '../../src/lib/close-matches';

type Case = readonly [word: string, possibilities: readonly string[], n?: number, cutoff?: number];

/**
 * Recorded: the long options and command names the corpus is built from, and what earlier
 * releases suggested for each case below, in the order the cases are built.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'lib', 'close-matches.json'), 'utf8'),
) as { options: string[]; commands: string[]; every_word: string[][] };

const LONG_OPTIONS = RECORDED.options;
const COMMANDS = RECORDED.commands;

function typos(word: string): string[] {
  const out = [word, word.slice(0, -1), word.slice(1), `${word}x`, word.toUpperCase()];
  if (word.length > 3)
    out.push(word.slice(0, 2) + word.slice(3), `${word.slice(0, 3)}-${word.slice(3)}`);
  return out;
}

describe('getCloseMatches is the close-match search earlier releases ran', () => {
  test('on every option, every command, and typos of each', () => {
    const cases: Case[] = [];
    for (const option of LONG_OPTIONS)
      for (const word of typos(option)) cases.push([word, LONG_OPTIONS]);
    for (const command of COMMANDS) for (const word of typos(command)) cases.push([word, COMMANDS]);
    for (const word of ['lst', 'stat', 'doc', 'up', 'x', '', '--', '-', 'skil', 'instal']) {
      cases.push([word, COMMANDS], [word, ['install', 'status']]);
    }
    const expected = RECORDED.every_word;
    expect(cases).toHaveLength(expected.length);
    cases.forEach(([word, possibilities, n, cutoff], at) => {
      expect([word, getCloseMatches(word, possibilities, n, cutoff)]).toEqual([word, expected[at]]);
    });
  });

  test('on ties, repeated elements, n, cutoff, astral characters and autojunk', () => {
    const long = `${'ab'.repeat(120)}c`;
    const cases: Case[] = [
      ['abcd', ['abce', 'abcf', 'abcg', 'abch'], 2],
      ['aaaa', ['aa', 'aaa', 'aaaaa', 'a', 'baaa']],
      ['hello', ['hallo', 'hullo', 'jello', 'yellow', 'hell'], 5, 0.5],
      ['abc', ['abc', 'abc', 'cab', 'bca'], 3, 0.0],
      ['a\u{1F600}b', ['a\u{1F600}c', 'a\u{1F601}b', 'ab'], 3, 0.3],
      [long, [`${'ab'.repeat(119)}cc`, `${'ba'.repeat(120)}c`, 'abc'], 3, 0.1],
      ['--verbose', ['--version', '--help'], 3, 0.6],
      ['--json', ['--help']],
    ];
    // What earlier releases suggested for each case, in order.
    const expected = [
      ['abch', 'abcg'],
      ['aaaaa', 'aaa', 'baaa'],
      ['hell', 'jello', 'hullo', 'hallo', 'yellow'],
      ['abc', 'abc', 'cab'],
      ['ab', 'a\u{1F601}b', 'a\u{1F600}c'],
      [`${'ab'.repeat(119)}cc`],
      ['--version'],
      [],
    ];
    cases.forEach(([word, possibilities, n, cutoff], at) => {
      expect(getCloseMatches(word, possibilities, n, cutoff)).toEqual(expected[at]);
    });
  });

  test('ratio() is the ratio earlier releases computed, to the last bit', () => {
    const pairs: [string, string][] = [
      ['--js', '--json'],
      ['lst', 'cluster'],
      ['abcd', 'bcde'],
      ['', ''],
      ['', 'a'],
    ];
    const expected = [0.8, 0.6, 0.75, 1.0, 0.0];
    pairs.forEach(([a, b], at) => expect(new SequenceMatcher(a, b).ratio()).toBe(expected[at]));
  });

  test('refuses what earlier releases refuse', () => {
    expect(() => getCloseMatches('a', ['a'], 0)).toThrow(RangeError);
    expect(() => getCloseMatches('a', ['a'], 3, 1.5)).toThrow(RangeError);
  });
});
