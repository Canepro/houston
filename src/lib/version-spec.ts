/**
 * A hand-written subset of the version-specifier standard: enough to read `data/versions.yaml` and no more.
 *
 * The surface is what `versions.ts` asks of the specifier standard: parse a version, order two versions,
 * and test a version against a specifier. `versions.yaml` uses exactly
 * three specifier shapes -- `>=X`, `>=X,<Y` and `<X` -- so those three are implemented and
 * **everything else throws**. A silent mistranslation of a specifier nobody implemented would
 * pair the wrong MongoDB with a customer's Rocket.Chat, which is the one job this tool has.
 *
 * TWO RULES THAT LOOK LIKE EDGE CASES AND ARE NOT. Both were measured against the specifier standard
 * reference implementation:
 *
 *  1. **Pre-releases sort BELOW their release.** `8.0rc1 < 8.0.0`, so `8.0rc1` fails
 *     `>=8.0.0` and falls through to the next rule.
 *
 *  2. **`<V` excludes a pre-release OF V**, per the specifier standard: "The exclusive ordered
 *     comparison <V MUST NOT allow a pre-release of the specified version unless the
 *     specified version is itself a pre-release." So `8.0rc1 < 8.0.0` is *false* as a
 *     SPECIFIER even though it is true as an ordering, and `8.0rc1` therefore matches
 *     no rule in `versions.yaml` at all and `resolve()` raises.
 *
 * **That last outcome is BEHAVIOUR, not a bug to fix.** It is the established behaviour,
 * and `versions.test.ts` pins it. Rules 1 and 2 together are the only reason `8.0rc1`
 * behaves differently from `8.1.0rc2`, which does match.
 *
 * NOT IMPLEMENTED, deliberately, each of which throws rather than guessing: `==`, `!=`,
 * `~=`, `===`, `>`, `<=`, wildcards, and a specifier's pre-release override. Add one
 * when `versions.yaml` needs it, with a corpus row proving it agrees.
 */

import { stripText } from './float-text';

/** Which kind of pre-release, in the order the specifier standard sorts them. */
const PRE_ORDER: Readonly<Record<string, number>> = Object.freeze({ a: 0, b: 1, rc: 2 });

/** The spellings the specifier standard normalises onto each canonical pre-release letter. */
const PRE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  alpha: 'a',
  a: 'a',
  beta: 'b',
  b: 'b',
  c: 'rc',
  pre: 'rc',
  preview: 'rc',
  rc: 'rc',
});

const POST_ALIASES = new Set(['post', 'rev', 'r']);

/**
 * The specifier standard's own grammar, transcribed. It is anchored with `\s*` at both ends, so
 * surrounding whitespace is accepted -- `8.0\n` parses, which is exactly why
 * `versions.MONGO_TAG_RE` needs its own stricter anchor and gets one. That `\s` is the
 * `STRIP_CHARS` set, not JavaScript's: the input is stripped with stripText before the
 * match, because the two sets part ways -- `\x1c`-`\x1f` and NEL are in the one and not in
 * JavaScript's, so `versions $'\x1c8.5.1'` resolved in earlier releases and was "not a
 * valid version" here, and a BOM is whitespace to JavaScript alone.
 */
const VERSION_RE = new RegExp(
  '^' +
    'v?' +
    '(?:(?<epoch>[0-9]+)!)?' +
    '(?<release>[0-9]+(?:\\.[0-9]+)*)' +
    '(?<pre>[._-]?(?<preL>alpha|a|beta|b|preview|pre|c|rc)[._-]?(?<preN>[0-9]+)?)?' +
    '(?<post>(?:-(?<postN1>[0-9]+))|(?:[._-]?(?<postL>post|rev|r)[._-]?(?<postN2>[0-9]+)?))?' +
    '(?<dev>[._-]?(?<devL>dev)[._-]?(?<devN>[0-9]+)?)?' +
    '(?:\\+(?<local>[a-z0-9]+(?:[._-][a-z0-9]+)*))?' +
    '$',
  'i',
);

export class InvalidVersion extends Error {}
export class InvalidSpecifier extends Error {}

export interface Version {
  /** The normalised string, as the specifier standard renders it. */
  readonly text: string;
  readonly epoch: number;
  readonly release: number[];
  /** `['rc', 1]` or null. */
  readonly pre: [string, number] | null;
  readonly post: number | null;
  readonly dev: number | null;
  readonly local: string | null;
  readonly isPrerelease: boolean;
}

function num(value: string | undefined): number {
  return value === undefined || value === '' ? 0 : Number(value);
}

/** Parse a version string, or throw `InvalidVersion`. */
export function parseVersion(text: string): Version {
  const m = VERSION_RE.exec(stripText(text));
  if (m === null || m.groups === undefined) {
    throw new InvalidVersion(`${JSON.stringify(text)} is not a valid version`);
  }
  const g = m.groups;

  const release = (g.release as string).split('.').map(Number);
  const epoch = num(g.epoch);

  let pre: [string, number] | null = null;
  if (g.preL !== undefined) {
    const letter = PRE_ALIASES[g.preL.toLowerCase()];
    // Unreachable via VERSION_RE, which only matches the aliased spellings. Kept so a
    // future edit to the grammar cannot introduce a silently unranked pre-release.
    if (letter === undefined) throw new InvalidVersion(`unknown pre-release ${g.preL}`);
    pre = [letter, num(g.preN)];
  }

  let post: number | null = null;
  if (g.postN1 !== undefined) {
    // The implicit `-N` form, as in `1.0-1`, which the specifier standard reads as `1.0.post1`.
    post = num(g.postN1);
  } else if (g.postL !== undefined && POST_ALIASES.has(g.postL.toLowerCase())) {
    post = num(g.postN2);
  }

  const dev = g.devL !== undefined ? num(g.devN) : null;
  const local = g.local === undefined ? null : g.local.toLowerCase().replace(/[._-]/g, '.');

  // A dev release is a pre-release too: `8.5.1.dev0` is a pre-release to the specifier standard
  // reference implementation, and the corpus has a row for it.
  const isPrerelease = pre !== null || dev !== null;

  return {
    text: renderVersion({ epoch, release, pre, post, dev, local }),
    epoch,
    release,
    pre,
    post,
    dev,
    local,
    isPrerelease,
  };
}

function renderVersion(v: {
  epoch: number;
  release: number[];
  pre: [string, number] | null;
  post: number | null;
  dev: number | null;
  local: string | null;
}): string {
  let out = '';
  if (v.epoch !== 0) out += `${v.epoch}!`;
  out += v.release.join('.');
  if (v.pre !== null) out += `${v.pre[0]}${v.pre[1]}`;
  if (v.post !== null) out += `.post${v.post}`;
  if (v.dev !== null) out += `.dev${v.dev}`;
  if (v.local !== null) out += `+${v.local}`;
  return out;
}

/** Trailing zeros are not significant: `8.0` and `8.0.0` are the same release. */
function compareRelease(left: number[], right: number[]): number {
  const width = Math.max(left.length, right.length);
  for (let i = 0; i < width; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * The sort key for the pre/post/dev block, as the specifier standard orders it:
 *
 *     X.devN  <  X{a|b|rc}N  <  X  <  X.postN
 *
 * Encoded as a tuple compared left to right. `-1` is the sentinel that sorts below every
 * real value and `Infinity` the one that sorts above.
 */
function preKey(v: Version): [number, number] {
  if (v.pre !== null) {
    const rank = PRE_ORDER[v.pre[0]];
    return [rank ?? 0, v.pre[1]];
  }
  // No pre-release. A bare dev release (`1.0.dev1`) sorts below every pre-release of
  // the same release; anything else sorts above all of them.
  if (v.dev !== null && v.post === null) return [-1, 0];
  return [Infinity, 0];
}

/**
 * The local-version sort key, as the specifier standard defines it.
 *
 * Each dot-separated segment is compared as a NUMBER when it is all digits and as a
 * STRING otherwise, and a numeric segment always sorts above an alphanumeric one. A
 * version with no local label sorts below every version that has one.
 *
 * `[-1, segment]` for the alphanumeric case is the sentinel pair: -1 is below every real
 * segment number, so any alphanumeric segment loses to any numeric one, and the string
 * only breaks ties between two alphanumerics.
 */
function localKey(v: Version): [number, string][] | null {
  if (v.local === null) return null;
  return v.local
    .split('.')
    .map((part) => (/^[0-9]+$/.test(part) ? [Number(part), ''] : [-1, part]));
}

function compareLocal(left: Version, right: Version): number {
  const a = localKey(left);
  const b = localKey(right);
  // No local label at all sorts BELOW any local label: `1.0 < 1.0+abc`.
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const width = Math.max(a.length, b.length);
  for (let i = 0; i < width; i += 1) {
    const x = a[i];
    const y = b[i];
    // A shorter local label sorts below a longer one that shares its prefix:
    // `1.0+local < 1.0+local.1`.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x[0] !== y[0]) return x[0] < y[0] ? -1 : 1;
    if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
  }
  return 0;
}

/**
 * -1, 0 or 1, ordering two versions exactly as `packaging` does.
 *
 * THE LOCAL LABEL IS COMPARED HERE, and it is deliberately NOT compared by the `>=` and
 * `<` specifiers, which strip it first (see `publicOf`). Those really are two different
 * rules in the specifier standard and conflating them is easy: this function started out ignoring the
 * local label, which is right for a specifier and wrong for an ordering, and a comparison
 * against packaging caught it on `8.5.1+local` against `8.5.1+local.1`.
 */
export function compareVersions(left: Version, right: Version): number {
  if (left.epoch !== right.epoch) return left.epoch < right.epoch ? -1 : 1;

  const byRelease = compareRelease(left.release, right.release);
  if (byRelease !== 0) return byRelease;

  const [lp, ln] = preKey(left);
  const [rp, rn] = preKey(right);
  if (lp !== rp) return lp < rp ? -1 : 1;
  if (ln !== rn) return ln < rn ? -1 : 1;

  const lpost = left.post ?? -1;
  const rpost = right.post ?? -1;
  if (lpost !== rpost) return lpost < rpost ? -1 : 1;

  const ldev = left.dev ?? Infinity;
  const rdev = right.dev ?? Infinity;
  if (ldev !== rdev) return ldev < rdev ? -1 : 1;

  return compareLocal(left, right);
}

/**
 * The same version with its local label removed -- `Version.public` in `packaging`.
 *
 * The specifier standard: "local version labels MUST be ignored entirely when checking if candidate
 * versions match a given version specifier". So `1.0+abc` satisfies `>=1.0` and `<1.0`
 * behaves as though the label were not there.
 */
function publicOf(v: Version): Version {
  return v.local === null ? v : { ...v, local: null };
}

/** The two operators `versions.yaml` uses. Anything else is refused at parse time. */
const SUPPORTED = new Set(['>=', '<']);

interface Clause {
  operator: string;
  version: Version;
}

/**
 * A comma-separated specifier set: `>=8.0.0,<8.2.0`. Comma means AND.
 *
 * Throws `InvalidSpecifier` on any operator outside `{>=, <}` -- including perfectly
 * valid forms of the specifier standard such as `==`, `!=` and `~=`. Refusing is the point: a shape this
 * module does not implement must not be answered with a plausible boolean.
 */
export class SpecifierSet {
  readonly clauses: Clause[];

  constructor(readonly text: string) {
    this.clauses = [];
    for (const raw of text.split(',')) {
      const part = raw.trim();
      if (part === '') continue;
      const m = /^(>=|<=|==|!=|~=|===|>|<)\s*(.+)$/.exec(part);
      if (m === null) {
        throw new InvalidSpecifier(`${JSON.stringify(part)} is not a version specifier`);
      }
      const operator = m[1] as string;
      if (!SUPPORTED.has(operator)) {
        throw new InvalidSpecifier(
          `specifier ${JSON.stringify(part)} uses '${operator}', which this build does ` +
            `not implement (only ${[...SUPPORTED].join(' and ')}). Add it with a corpus ` +
            'row proving it agrees with packaging rather than guessing.',
        );
      }
      this.clauses.push({ operator, version: parseVersion(m[2] as string) });
    }
  }

  /** Whether `candidate` satisfies every clause. An empty set contains everything. */
  contains(candidate: Version): boolean {
    return this.clauses.every((clause) => satisfies(candidate, clause));
  }
}

function satisfies(raw: Version, clause: Clause): boolean {
  const { operator, version: spec } = clause;
  // A local label is ignored ENTIRELY when matching a specifier, so it is stripped once
  // here rather than at each comparison below.
  const candidate = publicOf(raw);

  if (operator === '>=') {
    // Nothing else is special about `>=`: a pre-release simply sorts below its release,
    // which is why `8.0rc1 >= 8.0.0` is false.
    return compareVersions(candidate, spec) >= 0;
  }

  // operator === '<'. Two conditions, and the second is the one that surprises people.
  if (compareVersions(candidate, spec) >= 0) return false;
  // The specifier standard: "<V MUST NOT allow a pre-release of the specified version unless the
  // specified version is itself a pre-release." `8.0rc1` is a pre-release of `8.0.0`,
  // so `<8.0.0` excludes it even though it sorts below.
  if (!spec.isPrerelease && candidate.isPrerelease) {
    if (compareRelease(candidate.release, spec.release) === 0) return false;
  }
  return true;
}

/** Convenience: does this version string satisfy this specifier string? */
export function matches(version: string, specifier: string): boolean {
  return new SpecifierSet(specifier).contains(parseVersion(version));
}

/** The highest parseable entry, or null. Unparseable entries are skipped. */
export function highest(tags: readonly string[]): string | null {
  let bestRaw: string | null = null;
  let bestVer: Version | null = null;
  for (const tag of tags) {
    let v: Version;
    try {
      v = parseVersion(tag);
    } catch {
      continue;
    }
    if (bestVer === null || compareVersions(v, bestVer) > 0) {
      bestVer = v;
      bestRaw = tag;
    }
  }
  return bestRaw;
}

/**
 * The oldest parseable entry, or null.
 *
 * Reported beside the chosen one, NEVER chosen: changing which end is taken would
 * repair one class of reproduction and break another.
 */
export function lowest(tags: readonly string[]): string | null {
  let bestRaw: string | null = null;
  let bestVer: Version | null = null;
  for (const tag of tags) {
    let v: Version;
    try {
      v = parseVersion(tag);
    } catch {
      continue;
    }
    if (bestVer === null || compareVersions(v, bestVer) < 0) {
      bestVer = v;
      bestRaw = tag;
    }
  }
  return bestRaw;
}
