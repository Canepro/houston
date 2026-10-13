import { setHoustonVersion } from '../../src/lib/jsonout';
import { MIN_PASSWORD } from '../../src/core/users';
import { escapeHtml, page, safeNext, setupPage, STATES, themeAttr } from '../../src/web/signin';

describe('the server-rendered sign-in document', () => {
  beforeEach(() => setHoustonVersion('1.0.0'));

  it('escapes every interpolated value exactly like html.escape with quote=True', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#x27;');
    const document = page({
      error: '<img src=x onerror=alert(1)>',
      nextUrl: `/jobs?q='"&<>`,
      server: `<script data-x="'">&`,
      theme: 'dark" autofocus onfocus="alert(1)',
    });

    expect(document).not.toContain('<img src=x');
    expect(document).not.toContain('autofocus onfocus');
    expect(document).toContain('value="/jobs?q=&#x27;&quot;&amp;&lt;&gt;"');
    expect(document).toContain('Server: &lt;script data-x=&quot;&#x27;&quot;&gt;&amp;');
    expect(document).not.toContain('signin-banner <img');
  });

  it('selects banner prose only from the fixed STATES table', () => {
    expect(STATES).toEqual({
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
      // Okta: one per reason `core/sso` refuses with, plus the callback with Okta off and
      // the person already signed in as somebody else.
      ...Object.fromEntries(Object.entries(STATES).filter(([state]) => state.startsWith('sso-'))),
    });
    expect(
      Object.keys(STATES)
        .filter((state) => state.startsWith('sso-'))
        .sort(),
    ).toEqual(
      [
        'admin',
        'denied',
        'disabled',
        'domain',
        'down',
        'email',
        'expired',
        'gone',
        'name',
        'noaccount',
        'noadmin',
        'off',
        'other',
        'provider',
        'store',
        'taken',
        'token',
      ].map((code) => `sso-${code}`),
    );
    for (const [state, [kind, message]] of Object.entries(STATES)) {
      expect(page({ error: state })).toContain(`<p class="signin-banner ${kind}">${message}</p>`);
    }
    expect(page({ error: 'attacker prose' })).not.toContain('attacker prose');
    expect(page({ error: 'constructor' })).not.toContain('function Object');
  });

  it('escapes the settable package version too', () => {
    setHoustonVersion(`<img src=x onerror='bad'>&`);
    const document = page();
    expect(document).toContain('houston &lt;img src=x onerror=&#x27;bad&#x27;&gt;&amp;');
    expect(document).not.toContain('<img src=x');
  });

  it.each([
    ['/wanted?x=1', '/wanted?x=1'],
    [' /wanted ', '/wanted'],
    ['', '/'],
    ['relative', '/'],
    ['https://evil.example', '/'],
    ['//evil.example/path', '/'],
    ['/\\evil.example/path', '/'],
    ['/safe\\later', '/'],
    ['\u001c/wanted\u001c', '/wanted'],
    // A browser drops tab, CR and LF before it parses a Location: each of these is //evil.
    ['/\t/evil.example', '/'],
    ['/\n/evil.example', '/'],
    ['/\r/evil.example', '/'],
    ['/a\u007fb', '/'],
  ])('reduces next=%j to %j', (value, expected) => {
    expect(safeNext(value)).toBe(expected);
  });

  it('allows only the two literal theme attributes', () => {
    expect(themeAttr(' dark ')).toBe(' data-theme="dark"');
    expect(themeAttr('light')).toBe(' data-theme="light"');
    expect(themeAttr('dark" onload="bad')).toBe('');
    expect(themeAttr('\u001cdark\u001c')).toBe(' data-theme="dark"');
  });

  it('renders transport and retry state without client-side logic', () => {
    const document = page({ error: 'rate', secure: false, retryAfter: 9 });
    expect(document).toContain('content="10"');
    expect(document).toContain('This connection is not encrypted');
    expect(document).toContain('<form method="post" action="/signin"');
  });

  it('renders the first-run form with the shared password minimum', () => {
    const document = setupPage('light');
    expect(document).toContain(`minlength="${MIN_PASSWORD}"`);
    expect(document).toContain('<script src="/setup.js"></script>');
  });
});
