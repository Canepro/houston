/**
 * The two journal repairs a killed seed leaves behind.
 *
 * Above tier 0, because it reaches the runner record and the RC seam and the layer gate
 * says so. Both notes are written by `apply.seed` around the
 * settings it turns off; these are what puts them back when the process that turned them off
 * did not survive to do it itself.
 */
import * as config from '../lib/config';

import * as journal from '../core/journal';
import { type Auth, setSetting } from '../core/rcapi';
import { adminPass, readMeta } from '../core/runner/record';

type Login = (meta: Awaited<ReturnType<typeof readMeta>>) => Promise<Auth | null>;

/** `login` arrives from the journal's untyped recovery loop, so `undefined` is real. */
type MaybeLogin = Login | null | undefined;

async function repairSetting(
  entry: journal.Entry,
  login: MaybeLogin,
  setting: string,
): Promise<boolean> {
  if (login === null || login === undefined) return false;
  const meta = await readMeta(entry.workspace);
  const auth = await login(meta);
  if (auth === null) return false;
  return await setSetting(meta.rootUrl, auth, adminPass(meta), setting, true);
}

async function repairRateLimiter(
  entry: journal.Entry,
  _emit: unknown,
  login: MaybeLogin,
): Promise<boolean> {
  return await repairSetting(entry, login, config.RC_RATE_LIMITER_SETTING);
}

async function repairEmail2fa(
  entry: journal.Entry,
  _emit: unknown,
  login: MaybeLogin,
): Promise<boolean> {
  return await repairSetting(entry, login, journal.EMAIL_2FA_SETTING);
}

export function installJournalRepairs(): void {
  journal.registerRepair(journal.RATE_LIMITER_OFF, repairRateLimiter as journal.RepairHandler);
  journal.registerRepair(journal.EMAIL_2FA_OFF, repairEmail2fa as journal.RepairHandler);
}
