/**
 * Pure version and preset compatibility policy for backup restores.
 *
 * Kept apart from the archive and runtime operations so the web UI can ask what a restore
 * would mean without depending on the code that stops a workspace or invokes MongoDB tools.
 */
import { InvalidVersion, compareVersions, parseVersion, type Version } from '../lib/version-spec';
import { quotedText, isTruthy } from '../lib/format';
import type { Metadata } from './runner/record';

type Bag = Record<string, unknown>;

function versionOf(value: unknown): Version | null {
  try {
    return parseVersion(String(value));
  } catch (error) {
    if (error instanceof InvalidVersion) return null;
    throw error;
  }
}

export interface Compatibility {
  allowed: boolean;
  blocked_reason: string;
  direction: string;
  requires_flag: string;
  warnings: string[];
  from_version: string;
  to_version: string;
}

/** Whether this bundle may be restored into this repro. */
export function compatibility(manifest: Bag, meta: Metadata): Compatibility {
  const warnings: string[] = [];
  const src = String(manifest.rc_version ?? '');
  const dst = String(meta.rcVersion);
  const sv = versionOf(src);
  const dv = versionOf(dst);
  let direction = 'same';
  let requiresFlag = '';
  let blocked = '';

  if (sv === null || dv === null) {
    warnings.push(
      `cannot compare versions ${quotedText(src)} and ${quotedText(dst)}; proceeding blind`,
    );
  } else if (compareVersions(dv, sv) > 0) {
    direction = 'upgrade';
    requiresFlag = 'allow_upgrade';
    warnings.push(
      `${src} data into a ${dst} workspace: Rocket.Chat will run migrations on ` +
        'boot. That is an upgrade test, not a plain restore.',
    );
  } else if (compareVersions(dv, sv) < 0) {
    direction = 'downgrade';
    blocked =
      `${src} data cannot be restored into an older ${dst} workspace: ` +
      'Rocket.Chat does not support downgrading a migrated database.';
  }

  const smt = versionOf(manifest.mongo_tag ?? '');
  const dmt = versionOf(meta.mongoTag);
  if (smt !== null && dmt !== null && (smt.release[0] ?? 0) !== (dmt.release[0] ?? 0)) {
    warnings.push(
      `MongoDB major differs (dump from ${smt.text}, target runs ${dmt.text}); a restore ` +
        'across majors can fail on feature compatibility.',
    );
  }

  // A truth test on the manifest's `preset`, so `0`, `false` and `""` do not draw a
  // warning about a preset the bundle never named.
  const preset = manifest.preset;
  if (isTruthy(preset) && String(preset) !== meta.preset) {
    warnings.push(
      `the dump came from preset ${quotedText(String(preset))} but this repro is ` +
        `${quotedText(meta.preset)}; the data may reference services that do not exist here.`,
    );
  }
  // A truth test on `sidecar_volumes` again, and its items joined with `", "`: a string
  // joins its CHARACTERS, as it always has, which a list-only check silently skipped.
  const sidecars = manifest.sidecar_volumes;
  if (isTruthy(sidecars)) {
    const joined = Array.isArray(sidecars)
      ? sidecars.map((name) => String(name)).join(', ')
      : typeof sidecars === 'string'
        ? [...sidecars].join(', ')
        : String(sidecars);
    warnings.push(
      'sidecar data is NOT in this bundle ' +
        `(${joined}); uploads and IdP state will ` +
        'be missing even though the database references them.',
    );
  }
  if (isTruthy(manifest.live)) {
    warnings.push('this dump was taken with --live, so it may be inconsistent.');
  }

  return {
    allowed: blocked === '',
    blocked_reason: blocked,
    direction,
    requires_flag: requiresFlag,
    warnings,
    from_version: src,
    to_version: dst,
  };
}
