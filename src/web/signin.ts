/**
 * The sign-in document.
 *
 * A server-rendered page with no JavaScript, not a state inside the SPA. Three reasons,
 * in order:
 *
 * - The SPA assumes authenticated API calls succeed and a repro list is reachable.
 *   Opening the module that maps the whole API surface to an unauthenticated caller is
 *   needless exposure for a form with two fields.
 * - The server renderer is directly exercisable without booting the browser harness.
 * - HTTP Basic's failure mode was the browser's own grey dialog, with no error text,
 *   styling or way back. A page that needs JavaScript to render its own error would keep
 *   half of that failure mode.
 *
 * The page is a real `<form method="post">`; the CSP therefore permits
 * `form-action 'self'` while still refusing off-origin submissions.
 */

import { MIN_PASSWORD } from '../core/users';
import { getHoustonVersion } from '../lib/jsonout';
import { stripText } from '../lib/format';

export type SigninState = readonly [kind: string, message: string];

/** Fixed banners: a query parameter selects text but can never supply it. */
export const STATES: Readonly<Record<string, SigninState>> = Object.freeze({
  bad: ['bad', 'That name or password is not right.'],
  rate: ['bad', 'Too many attempts from this address. Try again in a moment.'],
  expired: ['warn', 'Your session expired. Sign in again to carry on.'],
  signedout: ['ok', 'Signed out.'],
  revoked: ['warn', 'That session was signed out from somewhere else.'],
  required: ['warn', 'Sign in to use houston.'],
  nouser: [
    'bad',
    'There are no accounts on this server yet. Create one on the host: ' +
      'houston users add &lt;name&gt;',
  ],
});

/** HTML-escape `value`: `&`, `<`, `>`, `"` and `'` (as `&#x27;`). */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

/** `data-theme="dark"` for a fixed choice, or nothing so CSS decides. */
export function themeAttr(value: string | null | undefined): string {
  const selected = stripText(value || '');
  return selected === 'dark' || selected === 'light' ? ` data-theme="${selected}"` : '';
}

/** Reduce a post-sign-in destination to one same-origin absolute path. */
export function safeNext(value: string | null | undefined): string {
  const destination = stripText(value || '/');
  if (!destination.startsWith('/') || destination.startsWith('//') || destination.includes('\\')) {
    return '/';
  }
  return destination;
}

export interface SigninPageOptions {
  error?: string;
  nextUrl?: string;
  server?: string;
  secure?: boolean;
  retryAfter?: number;
  theme?: string;
}

/** Render the complete sign-in document. Pure: no request object is needed. */
export function page({
  error = '',
  nextUrl = '/',
  server = '',
  secure = true,
  retryAfter = 0,
  theme = '',
}: SigninPageOptions = {}): string {
  const state = Object.hasOwn(STATES, error) ? (STATES[error] ?? ['', '']) : ['', ''];
  const [kind, message] = state;
  const banner = message ? `<p class="signin-banner ${kind}">${message}</p>` : '';
  const warning = secure
    ? ''
    : '<p class="signin-banner bad">This connection is not encrypted — your ' +
      'password will cross the network in the clear.</p>';
  const refresh =
    error === 'rate' && retryAfter
      ? `<meta http-equiv="refresh" content="${Math.trunc(retryAfter) + 1}">`
      : '';
  const where = escapeHtml(server || 'this host');
  const next = escapeHtml(safeNext(nextUrl));
  const version = escapeHtml(getHoustonVersion());

  return `<!doctype html>
<html lang="en"${themeAttr(theme)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · houston</title>
<link rel="stylesheet" href="/app.css">
${refresh}
</head>
<body class="signin-body">
<main class="signin">
  <div class="brand"><span class="dollar">$</span> houston</div>
  ${warning}
  ${banner}
  <form method="post" action="/signin" class="signin-form">
    <input type="hidden" name="next" value="${next}">
    <label for="u">Name</label>
    <input id="u" name="user" autocomplete="username" autocapitalize="none"
           autocorrect="off" spellcheck="false" autofocus required>
    <label for="p">Password</label>
    <input id="p" name="password" type="password"
           autocomplete="current-password" required>
    <button class="btn primary" type="submit">Sign in</button>
  </form>
  <p class="signin-foot">Server: ${where} &middot; houston ${version}</p>
  <p class="signin-foot">
    Lost your password? An admin resets it, on the host:<br>
    <code>houston users passwd &lt;name&gt;</code>
  </p>
</main>
</body>
</html>
`;
}

/**
 * The only script served before authentication. The setup key remains in the URL
 * fragment, which browsers never send in a request or Referer header.
 */
export const SETUP_JS = `"use strict";
var key = (location.hash || "").replace(/^#k=/, "");
// Out of the address bar on first paint, so it does not survive a screenshot or
// a shared link. Doing it before anything else means even an error leaves no key.
history.replaceState(null, "", "/setup");
var form = document.getElementById("f");
var err = document.getElementById("err");
if (!key) {
  err.textContent = "This page needs the setup link houston printed. "
    + "Copy the whole URL, including the part after #.";
  err.hidden = false;
  form.hidden = true;
}
form.addEventListener("submit", function (e) {
  e.preventDefault();
  err.hidden = true;
  var btn = form.querySelector("button");
  btn.disabled = true; btn.textContent = "Creating…";
  fetch("/api/session/first-run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      key: key, user: form.user.value.trim(), password: form.password.value,
    }),
  }).then(function (r) {
    return r.json().then(function (d) { return { ok: r.ok, d: d }; });
  }).then(function (res) {
    if (res.ok) { location.assign("/"); return; }
    err.textContent = res.d.error || "That did not work.";
    err.hidden = false;
    btn.disabled = false; btn.textContent = "Create admin account";
  }).catch(function () {
    err.textContent = "Could not reach the server.";
    err.hidden = false;
    btn.disabled = false; btn.textContent = "Create admin account";
  });
});
`;

/** Render the one-time first-admin document. */
export function setupPage(theme = ''): string {
  return `<!doctype html>
<html lang="en"${themeAttr(theme)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up houston</title>
<link rel="stylesheet" href="/app.css">
</head>
<body class="signin-body">
<main class="signin">
  <div class="brand"><span class="dollar">$</span> houston</div>
  <p class="signin-banner ok">This server has no accounts yet. Create the first
    one — it will be an admin, because somebody has to be able to add everyone
    else.</p>
  <p class="signin-banner bad" id="err" hidden></p>
  <form class="signin-form" id="f">
    <label for="u">Name</label>
    <input id="u" name="user" autocomplete="username" autocapitalize="none"
           autocorrect="off" spellcheck="false" autofocus required>
    <label for="p">Password</label>
    <input id="p" name="password" type="password"
           autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
    <button class="btn primary" type="submit">Create admin account</button>
  </form>
  <p class="signin-foot">At least ${MIN_PASSWORD} characters. houston stores only a
    scrypt hash — there is no password recovery, an admin resets it.</p>
</main>
<script src="/setup.js"></script>
</body>
</html>
`;
}
