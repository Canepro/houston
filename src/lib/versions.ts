/**
 * Resolve a Rocket.Chat version to its MongoDB pairing and runtime knobs.
 *
 * Two tiers:
 *
 *   1. LIVE     -- releases.rocket.chat/<version>/info, the authoritative per-release
 *                  compatibility data (pick the highest supported MongoDB).
 *   2. FALLBACK -- the shipped data/versions.yaml, used when offline or for old
 *                  releases that lack the field.
 *
 * flavor / shell / oplog are always derived from the RC and MongoDB majors, so there is
 * one rule (the MongoDB tag) to maintain, not four.
 *
 * TWO SHAPES OF THIS MODULE, both deliberate:
 *
 *  1. `resolveOnline` takes its fetcher as an argument and defaults to null. The
 *     network is a SEAM, which this module ranks below; it resolves offline in full,
 *     and a caller may inject a fetch. The default is therefore
 *     "no live lookup available", which takes exactly the same code path as an
 *     unreachable endpoint.
 *
 *  2. The map load is a module-level memo, process-wide and invisible, with an explicit
 *     reset for tests.
 */

import * as fs from 'fs';

import * as YAML from 'yaml';

import { dataPath } from './config';
import { quotedText } from './format';
import { ValidationError } from './errors';
import {
  highest as highestOf,
  lowest as lowestOf,
  parseVersion,
  SpecifierSet,
} from './version-spec';

export const RELEASES_URL = 'https://releases.rocket.chat/{version}/info';

/**
 * The OCI image-tag grammar, and the reason it is enforced rather than assumed.
 *
 * The Kubernetes Mongo manifest is built by interpolation, so a `--mongo` value carrying
 * a NEWLINE was substituted verbatim and the result was VALID YAML that `kubectl apply`
 * accepts -- a tag of
 * "8.0\n        securityContext:\n          privileged: true\n        hostPID: true"
 * rendered a privileged container with host PID. `mongo` is a plain request field and is
 * not privileged, so any member+ GUI account could reach it, bypassing the very control
 * that exists to stop a member choosing what code runs.
 *
 * Refused at the boundary rather than escaped at the template, because there are two
 * templates and one entry point: every caller that can supply a tag comes through
 * `applyMongoOverride`, and a tag that is not an OCI tag cannot name a real image anyway.
 *
 * **The `$` is the whole point of the anchor.** A `$` that also matches just before a
 * TRAILING NEWLINE, as it does in some regex dialects, let `"8.0\n"` satisfy it and the
 * guard let through the one character it exists to refuse; an end-of-string anchor was
 * the fix in earlier releases. JavaScript's `$` without the
 * `m` flag does NOT match before a trailing newline, so the plain anchor is already
 * correct here -- and it is spelled out because "it happens to be right in this
 * language" is exactly the kind of thing that gets refactored away.
 */
export const MONGO_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Refuse a `--mongo` value that is not an OCI image tag. See MONGO_TAG_RE. */
export function requireValidMongoTag(tag: string): void {
  if (!MONGO_TAG_RE.test(tag || '')) {
    throw new ValidationError(
      `--mongo ${JSON.stringify(tag)} is not a MongoDB image tag (want something like ` +
        "'8.0' or '7.0.14': letters, digits, '.', '_' and '-', starting with " +
        "a letter, digit or '_')",
    );
  }
}

export interface Resolved {
  rcVersion: string;
  rcImage: string;
  mongoTag: string;
  /** Keyed on the MONGO version: "official" (Mongo >= 8) | "bitnami-legacy" (< 8). */
  mongoFlavor: string;
  /** "mongosh" (Mongo >= 5) | "mongo" (older) -- the official flavor's init container. */
  mongoShell: string;
  /** RC major < 8 -> emit MONGO_OPLOG_URL (deprecated in 8.x). */
  oplog: boolean;
  /** "releases.rocket.chat" | "map (fallback)" | "map (no such release)". */
  source: string;
  note: string;
}

interface Rule {
  rc: string;
  mongo: string;
  note?: string;
}

interface VersionMap {
  default_rc_image?: string;
  rules: Rule[];
}

let mapCache: VersionMap | null = null;

function loadMap(): VersionMap {
  if (mapCache !== null) return mapCache;
  const text = fs.readFileSync(dataPath('versions.yaml'), 'utf8');
  const data = YAML.parse(text, { uniqueKeys: false }) as VersionMap | null;
  if (data === null || !Array.isArray(data.rules)) {
    throw new Error('data/versions.yaml is missing or has no rules');
  }
  mapCache = data;
  return data;
}

/** For tests: drop the memoised map. */
export function resetMapCache(): void {
  mapCache = null;
}

function mongoMajor(mongoTag: string): number {
  const head = mongoTag.split('.')[0] ?? '';
  // The major is the integer before the first dot, or 0 when that is not one. `Number("")`
  // is 0 and `Number("x")` is NaN, so both non-numeric shapes have to land on 0 here.
  const n = Number(head);
  return Number.isInteger(n) ? n : 0;
}

/**
 * Image flavor keyed on the MONGODB version. Mongo 8+ uses the official multi-arch
 * image; older tags use bitnami-legacy (Bitnami's public images were deprecated and
 * moved to the `bitnamilegacy` namespace).
 */
export function flavor(mongoTag: string): string {
  return mongoMajor(mongoTag) >= 8 ? 'official' : 'bitnami-legacy';
}

export function shell(mongoTag: string): string {
  return mongoMajor(mongoTag) >= 5 ? 'mongosh' : 'mongo';
}

function oplogFor(rcMajor: number): boolean {
  return rcMajor < 8;
}

/**
 * Apply a manual `--mongo` override, re-deriving flavor + shell from the tag.
 *
 * Validated here because this is the one place a caller-supplied tag enters: both
 * runtimes read `mongoTag` afterwards, and the Kubernetes one templates it into a
 * manifest. See MONGO_TAG_RE.
 */
export function applyMongoOverride(resolved: Resolved, mongoTag: string): void {
  requireValidMongoTag(mongoTag);
  resolved.mongoTag = mongoTag;
  resolved.mongoFlavor = flavor(mongoTag);
  resolved.mongoShell = shell(mongoTag);
}

/**
 * A `compatibleMongoVersions` entry as a tag the registry actually publishes.
 *
 * releases.rocket.chat is not consistent about the shape of this field. RC 7.12 and
 * below answer ["5.0","6.0","7.0"] and 8.x answers ["8.0"] -- but RC 7.13.x answers
 * ["5","6","7","8"], a bare major. The value was used verbatim as a docker tag, and
 * `mongodb/mongodb-community-server` publishes only <major>.<minor>, so RC 7.13.x
 * resolved to `8-ubi8` and every boot died on "failed to resolve reference ... not
 * found". Checked against the registry: 8-ubi8 and 7-ubi8 are 404; 8.0-ubi8 and 7.0-ubi8
 * are 200.
 *
 * A bare major means the GA series for that major, which is always `.0`. Anything that
 * already carries a minor is left alone, including a three-part tag like 8.0.4.
 *
 * Null for anything that is not a plain numeric version, so the caller falls back to
 * the curated map instead of inventing a tag out of something it cannot read.
 */
export function seriesTag(value: string): string | null {
  const parts = value.split('.');
  if (parts.length === 0 || !parts.every((p) => p !== '' && /^[0-9]+$/.test(p))) return null;
  return parts.length === 1 ? `${parts[0] as string}.0` : value;
}

/** Why this MongoDB tag, in the words the caller prints. */
export function mongoNote(best: string, compatible: string[], tag: string): string {
  // WHICH END WAS TAKEN, SAID OUT LOUD. The newest compatible MongoDB is chosen, and
  // for a support reproduction the interesting one is usually the customer's, which for
  // an older Rocket.Chat is usually the OLDEST supported. RC 4.8.7 offers
  // 3.6,4.0,4.2,4.4,5.0: this resolves 5.0 while the shipped versions.yaml rule gives
  // 4.4 -- so `up -v 4.8.7` and `up -v 4.8.7 --offline` pair a different MongoDB MAJOR,
  // and one of them changes whether the oplog path is exercised at all.
  let note = `compatibleMongoVersions=${compatible.join(',')}`;
  if (compatible.length > 1) {
    note +=
      ` (took the NEWEST, ${best}; the oldest supported is ` +
      `${lowestOf(compatible) ?? ''} — \`--mongo <tag>\` to pin the customer's)`;
  }
  if (tag !== best) {
    // Said out loud in `houston versions <x>`: the pairing on screen is then
    // explainable, instead of a number that appears nowhere in the API's answer.
    note += ` (bare major ${JSON.stringify(best)} -> ${tag}, the series the registry publishes)`;
  }
  return note;
}

/**
 * Set when the release endpoint answered 404 -- i.e. it was reachable and said this
 * version does not exist. Distinct from "could not ask", which is the only thing
 * returning null used to mean.
 */
export const NOT_A_RELEASE = 'not_a_release';

/** What a live lookup returns. Shaped so a caller can inject one without a network. */
export interface ReleaseInfoResponse {
  status: number;
  json(): unknown;
}

export type ReleaseFetcher = (url: string) => ReleaseInfoResponse | null;

/**
 * Query releases.rocket.chat. Returns null on any problem (the caller falls back).
 *
 * `why` collects WHY, because the caller has been unable to tell the difference. A 404
 * from a reachable endpoint means the version was never released; anything else means
 * the lookup failed. Both returned null, so `houston versions 99.99.99` fell through to
 * the curated map, found a rule matching the series, and exited 0 with a confident
 * pairing for a release that does not exist -- as did `8.5.1-rc.1`.
 */
export function resolveOnline(
  version: string,
  rcMajor: number,
  fetcher: ReleaseFetcher,
  why?: string[],
): Resolved | null {
  let resp: ReleaseInfoResponse | null;
  try {
    resp = fetcher(RELEASES_URL.replace('{version}', version));
  } catch {
    return null;
  }
  if (resp === null) return null;
  if (resp.status === 404 && why !== undefined) why.push(NOT_A_RELEASE);
  if (resp.status !== 200) return null;

  let payload: unknown;
  try {
    payload = resp.json();
  } catch {
    return null;
  }
  const compatibleRaw =
    payload !== null && typeof payload === 'object'
      ? (payload as Record<string, unknown>).compatibleMongoVersions
      : undefined;
  const compatible = Array.isArray(compatibleRaw) ? compatibleRaw.map(String) : [];

  const best = highestOf(compatible);
  if (best === null) return null; // old releases omit the field

  // The API's answer is not necessarily a tag. Returning null here rather than guessing
  // means the curated map decides, which is the better answer when the live value
  // cannot be read at all.
  const tag = seriesTag(best);
  if (tag === null) return null;

  return {
    rcVersion: version,
    rcImage: '', // filled in by resolve()
    mongoTag: tag,
    mongoFlavor: flavor(tag),
    mongoShell: shell(tag),
    oplog: oplogFor(rcMajor),
    source: 'releases.rocket.chat',
    note: mongoNote(best, compatible, tag),
  };
}

export interface ResolveOptions {
  offline?: boolean;
  /** Inject a live lookup. Absent means offline resolution, as if unreachable. */
  fetcher?: ReleaseFetcher;
}

/**
 * The refusal `resolve` raises for an unusable version string, or one no rule can match.
 * A class of its own, so a caller can catch exactly this without also swallowing the
 * other errors that pass through.
 */
export class InvalidVersionError extends Error {}

/**
 * Whether `resolve` would accept `version` at all -- the check it makes FIRST.
 *
 * Every caller has to fetch the release info before calling `resolve`, because `resolve` is
 * synchronous and HTTP is not. The version must be parsed before anything goes online, so
 * an unusable string never reaches the network; the callers here once fetched
 * first, and an invalid version sent `https://releases.rocket.chat/<whatever was typed>/info`
 * over the wire before being refused. A caller asks this, and skips the fetch, so the
 * refusal `resolve` then raises is unchanged and nothing is asked on the way to it.
 */
export function isValidVersion(version: string): boolean {
  try {
    parseVersion(version);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `version` to a full MongoDB pairing. */
export function resolve(version: string, options: ResolveOptions = {}): Resolved {
  let rcMajor: number;
  try {
    rcMajor = parseVersion(version).release[0] ?? 0;
  } catch {
    // `quotedText`, not `JSON.stringify`: the established message quotes the version in single
    // quotes, and `upgrade.plan` surfaces this sentence to whoever typed `--to`.
    throw new InvalidVersionError(
      `${quotedText(version)} is not a valid version (want e.g. 6.5.3)`,
    );
  }

  const data = loadMap();
  const rcImage = data.default_rc_image ?? 'registry.rocket.chat/rocketchat/rocket.chat';

  const why: string[] = [];
  if (options.offline !== true && options.fetcher !== undefined) {
    const online = resolveOnline(version, rcMajor, options.fetcher, why);
    if (online !== null) {
      online.rcImage = rcImage;
      return online;
    }
  }

  const candidate = parseVersion(version);
  for (const rule of data.rules) {
    if (new SpecifierSet(rule.rc).contains(candidate)) {
      let note = rule.note ?? '';
      if (why.includes(NOT_A_RELEASE)) {
        // SAID, rather than resolved silently. The pairing below is a rule for the
        // SERIES and is the best guess available -- but the endpoint was reachable and
        // answered 404, which is positive evidence that this version was never
        // published, and a caller that gets a clean answer for a typo will spend the
        // next ten minutes on a failing image pull.
        note =
          `releases.rocket.chat has no ${version} — it may be a typo, ` +
          'unreleased, or a pre-release tag. The pairing below comes ' +
          'from the series rule, not from that release.' +
          (note ? ` ${note}` : '');
      }
      return {
        rcVersion: version,
        rcImage,
        mongoTag: rule.mongo,
        mongoFlavor: flavor(rule.mongo),
        mongoShell: shell(rule.mongo),
        oplog: oplogFor(rcMajor),
        source: why.includes(NOT_A_RELEASE) ? 'map (no such release)' : 'map (fallback)',
        note,
      };
    }
  }

  // `8.0rc1` lands here and it is SUPPOSED TO. A pre-release sorts below its release so
  // it fails `>=8.0.0`, and the specifier standard forbids `<8.0.0` from admitting a pre-release of
  // 8.0.0 -- so no rule matches. See `version-spec.ts`; this is behaviour, not a gap.
  throw new InvalidVersionError(
    `no rule matches RC ${version} and the live lookup was unavailable`,
  );
}
