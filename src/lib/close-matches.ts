/**
 * Close-match suggestions, the source of every "Did you mean" and "Possible options" a
 * usage error carries.
 *
 * The usage error asks it which long options are close to an unknown one (`--js` ->
 * `--json`) and which commands are close to an unknown command (`lst` -> `'list',
 * 'cluster'`). The frozen CLI contract prints whatever it answers, so the suggestions are
 * part of the message, and a message that suggests something else is a different message.
 *
 * REPRODUCED, NOT APPROXIMATED. A Levenshtein distance or a prefix match would suggest
 * plausible names and would still disagree with the established messages on which ones,
 * and in what order. This is `SequenceMatcher` with no junk predicate and automatic junk
 * -- Ratcliff/Obershelp longest matching blocks, `b2j` built from the WORD, popular
 * elements junked only when the word is 200 elements or longer -- and `getCloseMatches`
 * keeping the `n` best by `(score, candidate)`, both descending.
 *
 * A string is compared by code point, so everything here is too: a candidate holding an
 * astral character is one element here and two UTF-16 units to JavaScript.
 */

/** A matching block: the `size` elements of `a` from `i` equal those of `b` from `j`. */
interface Block {
  readonly i: number;
  readonly j: number;
  readonly size: number;
}

/** String order by code point, where JavaScript's `<` compares UTF-16 units. */
function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
    const x = (a[at] as string).codePointAt(0) as number;
    const y = (b[at] as string).codePointAt(0) as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** The ratio: 2*M/T, and 1.0 for two empty sequences. */
function calculateRatio(matches: number, length: number): number {
  return length ? (2.0 * matches) / length : 1.0;
}

/** A sequence matcher with no junk predicate, as much of one as `getCloseMatches` spends. */
export class SequenceMatcher {
  private a: string[] = [];
  private b: string[] = [];
  private b2j = new Map<string, number[]>();
  private bjunk = new Set<string>();
  private fullbcount: Map<string, number> | null = null;
  private matchingBlocks: Block[] | null = null;

  constructor(a = '', b = '') {
    this.setSeq1(a);
    this.setSeq2(b);
  }

  setSeq1(a: string): void {
    this.a = Array.from(a);
    this.matchingBlocks = null;
  }

  setSeq2(b: string): void {
    this.b = Array.from(b);
    this.matchingBlocks = null;
    this.fullbcount = null;
    this.chainB();
  }

  /** Index `b`, then junk the popular elements of a long one (automatic junk). */
  private chainB(): void {
    const b2j = new Map<string, number[]>();
    this.b.forEach((element, index) => {
      const indices = b2j.get(element);
      if (indices === undefined) b2j.set(element, [index]);
      else indices.push(index);
    });
    // There is no junk predicate, so no element is junk by predicate.
    this.bjunk = new Set();
    const n = this.b.length;
    if (n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [element, indices] of [...b2j]) {
        if (indices.length > ntest) b2j.delete(element);
      }
    }
    this.b2j = b2j;
  }

  /** The longest matching block in `a[alo..ahi)` and `b[blo..bhi)`, with its junk extensions. */
  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Block {
    const { a, b, b2j } = this;
    const isbjunk = (element: string): boolean => this.bjunk.has(element);
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i += 1) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i] as string) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    while (
      besti > alo &&
      bestj > blo &&
      !isbjunk(b[bestj - 1] as string) &&
      a[besti - 1] === b[bestj - 1]
    ) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      !isbjunk(b[bestj + bestsize] as string) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }
    while (
      besti > alo &&
      bestj > blo &&
      isbjunk(b[bestj - 1] as string) &&
      a[besti - 1] === b[bestj - 1]
    ) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      isbjunk(b[bestj + bestsize] as string) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }
    return { i: besti, j: bestj, size: bestsize };
  }

  /** Every matching block, adjacent blocks collapsed, the `{la, lb, 0}` sentinel last. */
  getMatchingBlocks(): readonly Block[] {
    if (this.matchingBlocks !== null) return this.matchingBlocks;
    const la = this.a.length;
    const lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const found: Block[] = [];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
      const match = this.findLongestMatch(alo, ahi, blo, bhi);
      const { i, j, size: k } = match;
      if (k) {
        found.push(match);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    found.sort((x, y) => x.i - y.i || x.j - y.j || x.size - y.size);
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const blocks: Block[] = [];
    for (const { i: i2, j: j2, size: k2 } of found) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) blocks.push({ i: i1, j: j1, size: k1 });
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1) blocks.push({ i: i1, j: j1, size: k1 });
    blocks.push({ i: la, j: lb, size: 0 });
    this.matchingBlocks = blocks;
    return blocks;
  }

  ratio(): number {
    const matches = this.getMatchingBlocks().reduce((sum, block) => sum + block.size, 0);
    return calculateRatio(matches, this.a.length + this.b.length);
  }

  /** An upper bound on `ratio()`, from element counts alone. */
  quickRatio(): number {
    if (this.fullbcount === null) {
      const counts = new Map<string, number>();
      for (const element of this.b) counts.set(element, (counts.get(element) ?? 0) + 1);
      this.fullbcount = counts;
    }
    const fullbcount = this.fullbcount;
    const avail = new Map<string, number>();
    let matches = 0;
    for (const element of this.a) {
      const numb = avail.has(element)
        ? (avail.get(element) as number)
        : (fullbcount.get(element) ?? 0);
      avail.set(element, numb - 1);
      if (numb > 0) matches += 1;
    }
    return calculateRatio(matches, this.a.length + this.b.length);
  }

  /** A cheaper upper bound on `ratio()`, from the lengths alone. */
  realQuickRatio(): number {
    const la = this.a.length;
    const lb = this.b.length;
    return calculateRatio(Math.min(la, lb), la + lb);
  }
}

/**
 * At most `n` candidates whose ratio against `word` is at least `cutoff`, best first; ties
 * broken by the candidate, larger first, because the result is the `n` largest
 * `(score, candidate)` pairs.
 */
export function getCloseMatches(
  word: string,
  possibilities: Iterable<string>,
  n = 3,
  cutoff = 0.6,
): string[] {
  if (!(n > 0)) throw new RangeError(`n must be > 0: ${String(n)}`);
  if (!(cutoff >= 0 && cutoff <= 1)) throw new RangeError(`cutoff must be in [0.0, 1.0]`);
  const result: [number, string][] = [];
  const matcher = new SequenceMatcher();
  matcher.setSeq2(word);
  for (const candidate of possibilities) {
    matcher.setSeq1(candidate);
    if (
      matcher.realQuickRatio() >= cutoff &&
      matcher.quickRatio() >= cutoff &&
      matcher.ratio() >= cutoff
    ) {
      result.push([matcher.ratio(), candidate]);
    }
  }
  result.sort(([x, a], [y, b]) => (x !== y ? y - x : -compareCodePoints(a, b)));
  return result.slice(0, n).map(([, candidate]) => candidate);
}
