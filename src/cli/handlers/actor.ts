/**
 * Who is running the CLI, and how confident the answer is.
 *
 * An earlier version had no equivalent at all: the web layer sets the acting user per
 * request, and nothing set it for the CLI. So with accounts present, two people running
 * `houston up -v 8.5.1` derived the SAME workspace name -- the exact data-loss bug per-user
 * naming exists to prevent -- every owner gate compared an empty actor, `down --volumes`
 * could not say whose data it was about to delete, and every audit line read `-`.
 *
 * The origin is the audit log's evidence column:
 *   local     the OS login matched a known account -- the OS said so;
 *   asserted  HOUSTON_USER was set, honoured even for an unknown name -- a claim;
 *   system    no accounts (team mode is opt-in, from the first `users add`), or no match.
 */
import * as config from '../../lib/config';
import { getlogin } from '../../lib/login-name';
import { stripText } from '../../lib/float-text';

import type * as UsersNS from '../../core/users';

/**
 * The login name (`getlogin`), falling back to `$USER` where there is none (cron, a
 * container).
 *
 * An earlier version read `os.userInfo()` -- the EFFECTIVE uid's name, with `$USER` only for a
 * uid the password database lacks. Under `sudo -u vbob` that named the target account where
 * the established actor is the person who logged in, so a member ran an admin's chown; and
 * in a container or under cron, where there is no login uid, it named `root` or a service
 * account -- no account here, so an empty actor, which the owner gates allow -- where the
 * established actor is `$USER`.
 */
function loginName(): string {
  return getlogin() ?? process.env.USER ?? '';
}

export function cliActorAndOrigin(): [string, string] {
  const users = require('../../core/users') as typeof UsersNS;
  if (!users.anyUsers()) return ['', 'system'];
  const known = new Set(users.listUsers().map((user) => user.name));
  // `stripText`, which is not `trim()`: it strips \x1c-\x1f and NEL and keeps a BOM, so
  // HOUSTON_USER=$'\x1falice' is alice to it and was a stranger here -- refused a chown
  // alice may make -- while $'\ufeffalice' was alice here and a stranger there. Every gate,
  // audit line and event-log actor the CLI writes starts from this.
  const named = stripText(config.env('HOUSTON_USER')).toLowerCase();
  // Explicit: honoured even if unknown, so the mismatch shows up in `list` rather than
  // silently falling back to the shared namespace.
  if (named !== '') return [named, 'asserted'];
  const login = stripText(loginName()).toLowerCase();
  return known.has(login) ? [login, 'local'] : ['', 'system'];
}
