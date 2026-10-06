/**
 * HTTPS: the two certificate sources, and the report that tells them apart.
 *
 * `verify()` runs against a real TLS server on loopback -- the certificate it reads is one
 * this suite just minted with the local CA, so what is asserted is what openssl says about
 * a certificate that actually crossed a socket, not a fixture somebody typed.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tlsSocket from 'node:tls';

// The machine's trust store is the one thing stubbed: it answers as Node does unless a case
// says otherwise, and no case touches this box's own store.
jest.mock('node:tls', () => {
  const actual = jest.requireActual<typeof tlsSocket>('node:tls');
  return { ...actual, getCACertificates: jest.fn(actual.getCACertificates) };
});

import * as config from '../../src/lib/config';
import { ValidationError } from '../../src/lib/errors';

import {
  ACME_FILE,
  ACME_FILE_STAGING,
  CERT_WARN_AT,
  MODE_ACME,
  MODE_LOCAL,
  acmeArgs,
  acmeStorageName,
  budgetWarning,
  certNames,
  dnsCredentials,
  dnsEnvPath,
  dnsEnvVars,
  inferDnsProvider,
  localHostFor,
  normalizeAllowHost,
  normalizeDomain,
  notes,
  recentIssuances,
  recordIssuance,
  registrableDomain,
  rootUrl,
  tlsSpec,
  verify,
} from '../../src/core/tls';
import { ensureCa, issueLeaf } from '../../src/core/tls-local';

function writeDnsEnv(body: string): void {
  fs.mkdirSync(path.dirname(dnsEnvPath()), { recursive: true });
  fs.writeFileSync(dnsEnvPath(), body, 'utf8');
}

describe('a user-supplied hostname', () => {
  it('forgives the five ways --domain is mistyped, and says what it did', () => {
    // The official Rocket.Chat compose docs spell out that DOMAIN must be set "without
    // https:// or trailing slashes", which is a strong hint that people get it wrong --
    // and unguarded it produced ROOT_URL="https://https://host".
    expect(normalizeDomain('https://Lab.Example.COM/')).toEqual([
      'lab.example.com',
      "dropped 'https://'; dropped the trailing slash; lower-cased it",
    ]);
    expect(normalizeDomain(' lab.example.com ')[0]).toBe('lab.example.com');
    // A trailing dot is a legal FQDN but does not match SNI or a URL host.
    expect(normalizeDomain('lab.example.com.')[0]).toBe('lab.example.com');
    // Nothing to fix means nothing to say.
    expect(normalizeDomain('lab.example.com')).toEqual(['lab.example.com', '']);
  });

  it('REFUSES the forms that would change what is served', () => {
    // Silently dropping them would not do what the user asked.
    expect(() => normalizeDomain('lab.example.com/chat')).toThrow(/contains a path/u);
    expect(() => normalizeDomain('lab.example.com:8443')).toThrow(/contains a port/u);
    expect(() => normalizeDomain('*.example.com')).toThrow(/is a wildcard/u);
    expect(() => normalizeDomain('not a hostname')).toThrow(/not a valid hostname/u);
    expect(() => normalizeDomain('')).toThrow(ValidationError);
    expect(() => normalizeDomain('-lead.example.com')).toThrow(/not a valid hostname/u);
  });

  it('DROPS a port from --allow-host, because the guard never sees one', () => {
    // The Host guard compares hostnames with the port already stripped off the incoming
    // header, so keeping it made `--allow-host lab.example.com:9944` match nothing at all.
    // Measured on a lab box: three of the five forms somebody typed in a row were each
    // unmatchable, and `serve` reported itself healthy every time before 403ing everything.
    const [host, note] = normalizeAllowHost('lab.example.com:9944');
    expect(host).toBe('lab.example.com');
    expect(note).toContain("dropped the port '9944'");
    expect(normalizeAllowHost('https://lab.example.com/')[0]).toBe('lab.example.com');
  });

  it('keeps a bare IPv6 literal whole, and unwraps a bracketed one', () => {
    // More than one colon and no brackets has no port to drop and must survive untouched.
    expect(normalizeAllowHost('::1')[0]).toBe('::1');
    expect(normalizeAllowHost('[::1]:9944')[0]).toBe('::1');
    expect(normalizeAllowHost('[::1]')[0]).toBe('::1');
  });

  it('passes the documented wildcard through untouched', () => {
    expect(normalizeAllowHost('*')).toEqual(['*', '']);
    expect(normalizeAllowHost(' * ')).toEqual(['*', '']);
  });

  it('refuses an --allow-host with no hostname or a path in it', () => {
    expect(() => normalizeAllowHost(':9944')).toThrow(/has no hostname/u);
    expect(() => normalizeAllowHost('lab.example.com/admin')).toThrow(/contains a path/u);
  });
});

describe('the certificate budget', () => {
  it('Grafana public URL regression: counts two certificates for one host and deduplicates reuse', () => {
    recordIssuance('rc.grafana-regression.test', '', 'workspace');
    recordIssuance('rc.grafana-regression.test', '', 'grafana');
    recordIssuance('rc.grafana-regression.test', '', 'grafana');
    expect(recentIssuances('grafana-regression.test')).toBe(2);
  });
  it('counts a name ONCE, however often the workspace is recreated', () => {
    // Re-registering an existing name reuses its certificate and costs nothing, so
    // overwriting the date would make a long-lived workspace look like a fresh request
    // every time.
    recordIssuance('a.example.com', '2020-01-01');
    recordIssuance('a.example.com'); // today, and must not replace the old date
    expect(recentIssuances('example.com')).toBe(0);
    recordIssuance('b.example.com');
    expect(recentIssuances('example.com')).toBe(1);
  });

  it('warns only once there is still room to act', () => {
    expect(budgetWarning('a.example.com')).toBe('');
    for (let index = 0; index < CERT_WARN_AT; index += 1) {
      recordIssuance(`w${String(index)}.warn.test`);
    }
    const said = budgetWarning('x.warn.test');
    expect(said).toContain(`${String(CERT_WARN_AT)} certificates issued for warn.test`);
    expect(said).toContain('A wildcard certificate would remove this');
  });

  it('groups by the last two labels, which is right often and never a refusal', () => {
    // The real rule is the eTLD+1 from the Public Suffix List, which this project does not
    // carry. Acceptable only because this drives a warning: the worst case is mentioning a
    // wildcard slightly too early.
    expect(registrableDomain('t1.support.xyz.com')).toBe('xyz.com');
    expect(registrableDomain('example.com')).toBe('example.com');
    expect(registrableDomain('localhost')).toBe('localhost');
    expect(registrableDomain('')).toBe('');
    // WRONG for a multi-part suffix, and written down as such rather than left to be
    // discovered.
    expect(registrableDomain('a.example.co.uk')).toBe('co.uk');
  });

  it('never throws from a tally, whatever is on disk', () => {
    fs.mkdirSync(path.dirname(dnsEnvPath()), { recursive: true });
    fs.writeFileSync(path.join(config.home(), 'acme', 'issued.json'), 'not json', 'utf8');
    expect(recentIssuances('example.com')).toBe(0);
    expect(() => recordIssuance('c.example.com')).not.toThrow();
  });
});

describe('the dns-01 credentials', () => {
  it('names the provider from the variables, never from a flag', () => {
    // The variables ARE provider-specific, so the file already says which provider it is --
    // asking the user to repeat that on every `up` was ceremony.
    writeDnsEnv('CF_DNS_API_TOKEN=secret\n');
    expect(inferDnsProvider()[0]).toBe('cloudflare');
    writeDnsEnv('AWS_ACCESS_KEY_ID=x\nAWS_SECRET_ACCESS_KEY=y\n');
    expect(inferDnsProvider()[0]).toBe('route53');
    writeDnsEnv('DO_AUTH_TOKEN=x\n');
    expect(inferDnsProvider()[0]).toBe('digitalocean');
  });

  it('lets the LONGEST prefix win, so CLOUDFLARE_ is not read as something shorter', () => {
    writeDnsEnv('CLOUDFLARE_DNS_API_TOKEN=secret\n');
    expect(inferDnsProvider()[0]).toBe('cloudflare');
    writeDnsEnv('DIGITALOCEAN_TOKEN=x\n');
    expect(inferDnsProvider()[0]).toBe('digitalocean');
  });

  it('refuses to guess when the file names two providers, or none', () => {
    writeDnsEnv('CF_DNS_API_TOKEN=a\nLINODE_TOKEN=b\n');
    const [provider, why] = inferDnsProvider();
    expect(provider).toBe('');
    expect(why).toContain('more than one provider');
    writeDnsEnv('SOMETHING_ELSE=1\n');
    expect(inferDnsProvider()[1]).toContain('matches a known provider');
  });

  it('reads NAMES and never values, in both functions', () => {
    // `ps` shows command lines to every user on the box, which is why this is a file -- and
    // echoing a token in a message would undo that.
    writeDnsEnv('# a comment\n\nCF_DNS_API_TOKEN=super-secret\nCF_ZONE=zone-secret\n');
    expect(dnsEnvVars()).toEqual(['CF_DNS_API_TOKEN', 'CF_ZONE']);
    const [ok, message] = dnsCredentials('cloudflare');
    expect(ok).toBe(true);
    expect(message).toContain('CF_DNS_API_TOKEN');
    expect(message).not.toContain('super-secret');
  });

  it('says how to make the file when it is missing, and what is wrong when it is empty', () => {
    // Otherwise this surfaces only as an opaque Traefik failure minutes later.
    fs.rmSync(dnsEnvPath(), { force: true });
    expect(dnsEnvVars()).toEqual([]);
    const [missing, hint] = dnsCredentials('cloudflare');
    expect(missing).toBe(false);
    expect(hint).toContain('does not exist');
    expect(hint).toContain('CF_DNS_API_TOKEN');
    writeDnsEnv('# only a comment\n');
    const [empty, why] = dnsCredentials('cloudflare');
    expect(empty).toBe(false);
    expect(why).toContain('no KEY=VALUE lines');
  });
});

describe('the Traefik ACME flags', () => {
  it('asks for TLS-ALPN by default, which needs no second port', () => {
    const args = acmeArgs(tlsSpec({ mode: MODE_ACME, acmeEmail: 'ops@example.com' }));
    expect(args).toContain('--certificatesresolvers.le.acme.tlschallenge=true');
    expect(args).toContain('--certificatesresolvers.le.acme.email=ops@example.com');
    expect(args.join(' ')).toContain(`/etc/traefik/acme/${ACME_FILE}`);
    expect(args.join(' ')).not.toContain('caserver');
  });

  it('keeps staging in its OWN store, so a switch cannot mix the two', () => {
    const args = acmeArgs(tlsSpec({ acmeEmail: 'ops@example.com', acmeStaging: true }));
    expect(args.join(' ')).toContain(`/etc/traefik/acme/${ACME_FILE_STAGING}`);
    expect(args.join(' ')).toContain('acme-staging-v02.api.letsencrypt.org');
    expect(acmeStorageName(true)).toBe(ACME_FILE_STAGING);
    expect(acmeStorageName(false)).toBe(ACME_FILE);
  });

  it('switches to dns-01 with a provider, which needs no inbound connection', () => {
    const args = acmeArgs(
      tlsSpec({ acmeEmail: 'a@b', acmeChallenge: 'dns', acmeDnsProvider: 'cloudflare' }),
    );
    expect(args).toContain('--certificatesresolvers.le.acme.dnschallenge=true');
    expect(args).toContain('--certificatesresolvers.le.acme.dnschallenge.provider=cloudflare');
    expect(args).not.toContain('--certificatesresolvers.le.acme.tlschallenge=true');
  });

  it('offers http-01, because the other two can both be unavailable at once', () => {
    // Reported from an EC2 box where TLS-ALPN validation failed every time with `remote
    // error: tls: unrecognized name`, and where dns-01 was impossible because the operator
    // had the machine and not the DNS zone.
    const args = acmeArgs(tlsSpec({ acmeEmail: 'a@b', acmeChallenge: 'http' }));
    expect(args).toContain('--certificatesresolvers.le.acme.httpchallenge=true');
    expect(args).toContain('--certificatesresolvers.le.acme.httpchallenge.entrypoint=web');
  });
});

describe('what a workspace is told', () => {
  it('never claims a staging certificate is trusted', () => {
    // Staging roots are NOT in any trust store -- that is the whole point of staging.
    // Claiming otherwise sent people looking for a broken workspace when the browser
    // warning was the expected, correct outcome.
    const said = notes(
      tlsSpec({ mode: MODE_ACME, host: 'x.example.com', port: 443, acmeStaging: true }),
    ).join(' ');
    expect(said).toContain('STAGING');
    expect(said).toContain('deliberately NOT trusted');
    expect(said).toContain('the SUCCESS signal');
  });

  it('says a local certificate needs trust-ca, and cannot be used from a phone', () => {
    const said = notes(tlsSpec({ mode: MODE_LOCAL, host: localHostFor('t1'), port: 8443 }));
    expect(said[0]).toContain('https://t1.houston.localhost:8443');
    expect(said.join(' ')).toContain('houston trust-ca');
    expect(said.join(' ')).toContain('A phone cannot use this');
  });

  it('spells the port unless it is 443, or Rocket.Chat advertises a dead URL', () => {
    expect(rootUrl(tlsSpec({ host: 'x.test', port: 443 }))).toBe('https://x.test');
    expect(rootUrl(tlsSpec({ host: 'x.test', port: 8443 }))).toBe('https://x.test:8443');
  });
});

describe('what is ACTUALLY being served', () => {
  let server: tlsSocket.Server | null = null;
  let port = 0;

  /** A real TLS endpoint, serving a certificate this suite minted. */
  async function serving(host: string): Promise<void> {
    const [cert, key] = await issueLeaf(host);
    server = tlsSocket.createServer({ cert, key }, (socket) => socket.end());
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  }

  afterEach(async () => {
    if (server !== null) {
      const closing = server;
      server = null;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  });

  it('reports an untrusted-but-working endpoint as WORKING', async () => {
    // Staging and local-CA certs are untrusted by design; refusing to look at them would
    // report "broken" for a setup behaving exactly as intended.
    await serving('localhost');
    const [, caCrt] = await ensureCa();
    const report = await verify('localhost', { port, timeout: 5, cafile: caCrt });
    expect(report.serving).toBe(true);
    expect(report.error).toBe('');
    expect(report.issuer).toContain('houston local CA');
    expect(report.subject).toContain('localhost');
    expect(report.fallback).toBe(false);
    // TWO DIFFERENT QUESTIONS, kept apart: collapsing them made local mode always report
    // "trusted", because passing houston's own CA guarantees success and hides whether
    // `trust-ca` has run.
    expect(report.trusted_via_ca).toBe(true);
    expect(report.trusted).toBe(false);
  }, 60_000);

  it('counts a CA in the system store as trusted, which is what trust-ca puts there', async () => {
    // Node checks only its bundled roots unless told otherwise, so after `trust-ca` had put
    // houston's CA into the system store, `tls-status` still said "Not trusted by this
    // machine yet". The system store is stubbed here; this box's own is left alone.
    await serving('localhost');
    const [, caCrt] = await ensureCa();
    const roots = jest.mocked(tlsSocket.getCACertificates);
    const real = jest.requireActual<typeof tlsSocket>('node:tls').getCACertificates;
    roots.mockImplementation((kind) => (kind === 'system' ? [fs.readFileSync(caCrt, 'utf8')] : []));
    try {
      const report = await verify('localhost', { port, timeout: 5, cafile: caCrt });
      expect({ trusted: report.trusted, viaCa: report.trusted_via_ca }).toEqual({
        trusted: true,
        viaCa: true,
      });
    } finally {
      roots.mockImplementation(real);
    }
  }, 60_000);

  it('reads the names out of the SANs, which is where they may only exist', async () => {
    // cert-manager issues exactly that shape -- the name lives only in the SANs -- so
    // every Kubernetes workspace's certificate reported `Subject: ?`, which reads as a
    // parse failure rather than as a perfectly good certificate.
    await serving('rc.example.test');
    const report = await verify('127.0.0.1', { port, timeout: 5, sni: 'rc.example.test' });
    expect(report.names).toContain('rc.example.test');
    expect(report.names).toContain('localhost');
  }, 60_000);

  it('presents a different SNI than the address it dials, on request', async () => {
    // How you check what this host serves for a domain without letting a proxy in front
    // answer instead.
    await serving('sni.example.test');
    const report = await verify('127.0.0.1', { port, timeout: 5, sni: 'sni.example.test' });
    expect(report.serving).toBe(true);
    expect(report.subject).toContain('sni.example.test');
  }, 60_000);

  it('never throws for a CA file that is not there', async () => {
    // A fresh HOUSTON_HOME going straight to `--domain` has never minted a local
    // certificate, so `ca/ca.crt` is simply not there -- and `up` ended in a stack trace
    // after the workspace had been built and its certificate issued.
    await serving('localhost');
    const report = await verify('localhost', {
      port,
      timeout: 5,
      cafile: path.join(os.tmpdir(), 'houston-no-such-ca.crt'),
    });
    expect(report.serving).toBe(true);
    expect(report.trusted_via_ca).toBe(false);
  }, 60_000);

  it('reports nothing listening as a report, not an exception', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const dead = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const report = await verify('127.0.0.1', { port: dead, timeout: 5 });
    expect(report.serving).toBe(false);
    expect(report.error).not.toBe('');
  }, 60_000);

  it('reads the DNS names straight out of a PEM', async () => {
    const [cert] = await issueLeaf('pem.example.test', ['10.0.0.5']);
    const names = await certNames(cert);
    expect(names).toContain('pem.example.test');
    expect(names).toContain('localhost');
    // An IP SAN is not a DNS name and must not be reported as one.
    expect(names).not.toContain('10.0.0.5');
  }, 60_000);
});

describe('the TLS cases earlier releases were held to', () => {
  it('says how to leave staging, and calls only production publicly trusted', () => {
    // Staging is a config key, not a flag on `up`, so the way back to a trusted certificate
    // must name the command that turns it off -- with the workspace name threaded in.
    const staging = notes(
      tlsSpec({
        mode: MODE_ACME,
        host: 'rc1.example.com',
        port: 443,
        acmeEmail: 'a@b.c',
        acmeStaging: true,
      }),
      'rc1',
    ).join(' ');
    expect(staging.toLowerCase()).toContain('not trusted');
    expect(staging.toLowerCase()).not.toContain('publicly trusted');
    expect(staging.toLowerCase()).toContain('success signal');
    expect(staging).toContain('config unset acme.staging');
    expect(staging).toContain('tls-status --name rc1');
    const prod = notes(
      tlsSpec({ mode: MODE_ACME, host: 'rc1.example.com', port: 443, acmeEmail: 'a@b.c' }),
      'rc1',
    ).join(' ');
    expect(prod.toLowerCase()).toContain('publicly trusted');
  });

  it('infers five providers from their variables and never echoes a value', () => {
    for (const [body, expected] of [
      ['CF_DNS_API_TOKEN=x\n', 'cloudflare'],
      ['AWS_ACCESS_KEY_ID=x\nAWS_SECRET_ACCESS_KEY=y\n', 'route53'],
      ['DO_AUTH_TOKEN=x\n', 'digitalocean'],
      ['HETZNER_API_KEY=x\n', 'hetzner'],
      ['AZURE_CLIENT_ID=x\n', 'azuredns'],
    ] as const) {
      writeDnsEnv(body);
      const [provider, why] = inferDnsProvider();
      expect({ body, provider }).toEqual({ body, provider: expected });
      expect(why).not.toContain('secret');
      expect(why).not.toContain('=');
    }
  });

  it('names a subject-less certificate by its SANs, and reads garbage as no names', async () => {
    // cert-manager issues with NO subject at all, so `Subject: ?` read as a parse failure.
    const [crt] = await issueLeaf('probe.houston.localhost');
    const names = await certNames(crt);
    expect(names).toContain('probe.houston.localhost');
    expect(names).toContain('localhost');
    // This feeds a report, so anything unparseable is an empty list, never an exception.
    expect(await certNames('not a certificate')).toEqual([]);
  }, 60_000);
});

/**
 * A connection that fails is worded as earlier releases word it, the error's type name and
 * its text -- `Connection refused` -- where Node's
 * `ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:443` was another sentence on every
 * workspace that is not serving. Held to the wording earlier releases reported, recorded, for
 * a closed port, by address and by name, and for a name that does not resolve.
 */
describe('a TLS endpoint nothing is serving', () => {
  it('reports the failure as earlier releases report it', async () => {
    const closed = await new Promise<number>((resolve) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
    });
    const targets: [string, number][] = [
      ['127.0.0.1', closed],
      ['localhost', closed],
      ['no-such-host.invalid', 443],
    ];
    const recorded = ['Connection refused', 'Connection refused', 'Name or service not known'];
    const ours: string[] = [];
    for (const [host, port] of targets) ours.push((await verify(host, { port, timeout: 5 })).error);
    expect(ours).toEqual(recorded);
  }, 60_000);
});
