/**
 * `users`: who may sign in to the web GUI, managed from the terminal.
 *
 * It PRINTS AS IT GOES, as `users` always has.
 *
 * An earlier version returned a payload and drew it afterwards, which cannot say what
 * `users` says WHEN it says it: the `'Lucy.Felix' becomes 'lucy-felix'` note comes before the
 * prompt, and before the conflict of `users add BOB` where bob exists, so a renderer that
 * runs only on success never printed it; and the first-run line is decided by a read of the
 * accounts made AFTER the password is on screen. The payload's renderer had also lost most of
 * what is printed around it -- the two lines on why a password is shown once, the role
 * an added account got and the first-run link it spent, the roles-bound-the-GUI lines after a
 * role change, the second line of the empty listing, and in the listing the created date, the
 * EFFECTIVE role (`roleOf`, where it showed the raw column: `[52]` for a legacy timestamp
 * line, `[ADMIN]`, `[superuser]`), the `(implicit)` marker and its three lines, and the
 * password as the panel's LABEL, which is two columns wider for a one- or two-letter name.
 *
 * `json: none`, so what this prints and the code it exits with are the whole contract. Every
 * prose line is stdout, as the CLI has always written it off a terminal; a plain refusal is a
 * `ReproError` (exit 1) and a service refusal propagates with its own class.
 */
import { ReproError } from '../../lib/errors';
import { quotedText } from '../../lib/format';
import type { CliIo } from '../app';
import { say, writePanel } from '../render';

import { hiddenPrompt } from './prompt';

import type * as SessionsNS from '../../core/sessions';
import type * as UsersNS from '../../core/users';

/** How a password is asked for, as `HandlerDependencies.prompt` asks: hidden, by default. */
export type Prompt = (question: string, secret: boolean) => Promise<string>;

/** The `users` command's parameters, as the CLI hands them over. */
export interface UsersRequest {
  readonly action: string;
  readonly name: string;
  readonly role: string;
  readonly askPassword: boolean;
}

function usersService(): typeof UsersNS {
  return require('../../core/users') as typeof UsersNS;
}

/** The accounts, including the pre-roles implicit-admin migration state. */
function listGuiUsers(io: CliIo): void {
  const users = usersService();
  const rows = users.listUsers();
  if (rows.length === 0) {
    say(io, 'no users yet — add one with `houston users add <name>`');
    say(
      io,
      '  or just run `houston serve` — it prints a one-time link that creates the first one.',
    );
    return;
  }
  // The role read per row, as the service reads it: the EFFECTIVE role of the name
  // normalised, so a column the service reads as admin shows as admin, and a stored name
  // that is not in normalised form finds no account and shows `[]`.
  writePanel(
    io,
    'GUI users',
    rows.map((user) => [
      user.name,
      `${user.createdAt}  [${users.roleOf(user.name)}${user.role ? '' : ' (implicit)'}]`,
    ]),
  );
  const implicit = users.implicitAdmins();
  if (implicit.length > 0) {
    say(
      io,
      '  (implicit) = the role column is blank, which means admin. That is the\n' +
        '  migration for accounts made before roles existed, not a default.',
    );
    say(io, `  narrow one with: houston users role ${implicit[0] as string} member`);
  }
}

/** The authority, and the sessions revoked so it takes effect now. */
async function changeGuiUserRole(io: CliIo, name: string, role: string): Promise<void> {
  const users = usersService();
  if (!role)
    throw new ReproError(`\`users role ${name}\` needs a role (${users.ROLES.join(' | ')})`);
  const user = await users.setRole(name, role);
  // A role change signs the account out everywhere once its role is written, under
  // `locks/sessions.lock`, so a demotion reaches a browser that is already open rather than
  // waiting out a seven-day session. This build wrote the role and kept every session: the
  // demoted person stayed signed in and nothing said otherwise. The service does not revoke,
  // on purpose -- a role is not a credential -- so each front end does it, as the GUI's role
  // route already did.
  const ended = await (require('../../core/sessions') as typeof SessionsNS).revokeUser(name);
  say(io, `✓ ${quotedText(user.name)} is now ${user.role}.`);
  if (ended) say(io, `  ${ended} active session(s) signed out, so it takes effect now.`);
  say(
    io,
    '  roles bound the GUI. The CLI has no roles: anyone with a shell on this box\n' +
      '  is already in the docker group. A readonly user with an ssh key is not readonly.',
  );
}

/** The account goes, and the service ends its sessions. */
async function removeGuiUser(io: CliIo, name: string): Promise<void> {
  const ended = await usersService().remove(name);
  say(io, `✓ user ${quotedText(name)} removed.`);
  if (ended) say(io, `  ${ended} active session(s) signed out.`);
}

/**
 * The request validated, and a password minted or asked for.
 *
 * In the established order: the NAME -- for `passwd` as much as `add` -- before anything is
 * said or asked; the note on what the name became; the prompt; then the role, so a bad role
 * is refused after the prompt and before the password's length is looked at.
 */
async function passwordForUser(
  io: CliIo,
  request: UsersRequest,
  name: string,
  prompt: Prompt,
): Promise<[string, boolean]> {
  const users = usersService();
  users.requireValidName(name);
  if (name !== request.name) {
    say(
      io,
      `  ${quotedText(request.name)} becomes ${quotedText(name)} — an account name becomes part of a ` +
        'workspace name, and therefore a DNS label.',
    );
  }
  let password: string;
  let minted: boolean;
  if (request.askPassword) {
    password = await prompt(`Password for ${name}`, true);
    if (password !== (await prompt('Repeat', true))) {
      throw new ReproError('the two passwords do not match');
    }
    minted = false;
  } else {
    password = users.mintPassword();
    minted = true;
  }
  if (request.role && request.action === 'passwd') {
    throw new ReproError(
      '`users passwd` takes no role — change one with ' +
        `\`houston users role ${name} ${request.role}\``,
    );
  }
  if (request.role) users.requireValidRole(request.role);
  return [password, minted];
}

/** The one moment a generated credential exists in readable form. */
function reportGuiPassword(
  io: CliIo,
  action: string,
  added: UsersNS.User | null,
  ended: number,
  minted: boolean,
  name: string,
  password: string,
): void {
  say(io, `✓ user ${quotedText(name)} ${action === 'add' ? 'added' : 'password changed'}.`);
  if (minted) {
    // `(password, "")`: the password is the LABEL, so its cell carries the two spaces a
    // label is followed by.
    writePanel(io, `password for ${name}`, [[password, '']]);
    say(
      io,
      '  Shown once. houston keeps only a scrypt hash, so nobody — including you —\n' +
        '  can read it back. Send it over something the person can delete afterwards.',
    );
  }
  if (action === 'passwd' && ended) say(io, `  ${ended} active session(s) signed out.`);
  if (action === 'add' && added !== null) {
    say(
      io,
      `  role: ${added.role}` +
        (added.role === 'admin'
          ? '  (the first account has to be an admin, or nobody could promote anyone)'
          : `  — change it with \`houston users role ${name} <role>\``),
    );
    if (usersService().listUsers().length === 1) {
      say(io, '  `houston serve` will now ask for this login, and the first-run link is spent.');
    }
  }
}

/** Add an account, or replace its password, never from argv. */
async function setGuiPassword(
  io: CliIo,
  request: UsersRequest,
  name: string,
  prompt: Prompt,
): Promise<void> {
  const users = usersService();
  const [password, minted] = await passwordForUser(io, request, name, prompt);
  let ended = 0;
  let added: UsersNS.User | null = null;
  if (request.action === 'add') {
    // `add` is handed the NORMALISED role, the typed one having been validated in
    // `passwordForUser` just after the prompt. Passing argv through stored it as typed:
    // `users add dave ADMIN` wrote `:ADMIN` and audited `role=ADMIN`, and a role that led
    // with a line break (`$'\nmember'`, or `\r`, which `splitTextLines` breaks at) split the
    // account's line, so the member just created read back as an IMPLICIT admin. Validated
    // before it is normalised, because `normaliseRole` reads anything unknown as admin:
    // `reedonly` must stay a refusal.
    added = await users.add(name, password, request.role ? users.normaliseRole(request.role) : '');
  } else ended = await users.setPassword(name, password);
  reportGuiPassword(io, request.action, added, ended, minted, name, password);
}

/**
 * `users`, in its established order: the TYPED name is tested for emptiness, then normalised,
 * then each action checks what it checks.
 *
 * An earlier version tested the NORMALISED name, so `users remove '!!!'` said "needs a name"
 * (exit 1) where the established answer looks up '' and is NOT_FOUND (exit 4); it validated
 * the name only inside `add`, so `users passwd` with a 33-character name was "no user" (exit
 * 4), not the length refusal (exit 2); it prompted before validating anything, so `add <33
 * chars> --ask-password` asked for a password it was going to refuse; and `app.ts` refused an
 * unknown action before this ran, so `users ls` was "unknown action" where the established
 * answer first asks for the name.
 *
 * One normalisation for every branch, so `role`, `remove` and `passwd` find the account that
 * `add` created and every line printed names it the way the file spells it -- the service
 * normalises too, but it cannot fix what this layer PRINTS. The typed name is kept for the
 * one line that says what it became.
 */
export async function usersCommand(
  io: CliIo,
  request: UsersRequest,
  prompt: Prompt = (question) => hiddenPrompt(question),
): Promise<void> {
  const { action } = request;
  if (action === 'list') {
    listGuiUsers(io);
    return;
  }
  if (!request.name) {
    throw new ReproError(
      `\`users ${action}\` needs a name, e.g. \`houston users ${action} alice\``,
    );
  }
  const name = usersService().normalizeName(request.name);
  if (action === 'role') return await changeGuiUserRole(io, name, request.role);
  if (action === 'remove') return await removeGuiUser(io, name);
  if (action === 'add' || action === 'passwd') {
    return await setGuiPassword(io, request, name, prompt);
  }
  throw new ReproError(
    `unknown action ${quotedText(action)} (want: list | add | passwd | remove | role)`,
  );
}
