/**
 * The local CA: made once, and the leaf it signs has to be one a BROWSER will accept.
 *
 * `src/core/tls-local.ts`'s docstring says why the Kubernetes tier depends on it as much as
 * the rest of TLS does. Two cases here state the file-mode window in its own right: this is
 * a private key that can mint a certificate for any name the browser trusts.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { capture } from '../../src/seams/exec';
import type * as TlsplanNS from '../../src/core/lifecycle/tlsplan';

import {
  caDir,
  ensureCa,
  issueLeaf,
  leafExt,
  manualTrustInstructions,
} from '../../src/core/tls-local';

/** `openssl x509 -text`, as prose. */
async function describe_(certPath: string): Promise<string> {
  const res = await capture(['openssl', 'x509', '-in', certPath, '-noout', '-text'], {
    encoding: 'utf8',
    timeoutMs: 60_000,
  });
  return String(res.stdout ?? '');
}

const modeOf = (target: string) => (fs.statSync(target).mode & 0o777).toString(8);

describe('the local CA', () => {
  it('is made once and never regenerated, because trust-ca installed THAT one', async () => {
    const [key, crt] = await ensureCa();
    expect(fs.existsSync(key)).toBe(true);
    expect(fs.existsSync(crt)).toBe(true);
    const before = fs.readFileSync(crt);
    expect(await ensureCa()).toEqual([key, crt]);
    expect(fs.readFileSync(crt).equals(before)).toBe(true);
  }, 60_000);

  it('never leaves the signing key readable, not even briefly', async () => {
    // `openssl genrsa -out` creates the file at 0666 & ~umask and the chmod lands AFTER it,
    // so the directory has to be 0700 first: on a default umask that window is a real, if
    // brief, 0644 private key that can mint a certificate for any name a browser trusts.
    const [key] = await ensureCa();
    expect(modeOf(key)).toBe('600');
    expect(modeOf(caDir())).toBe('700');
  }, 60_000);
});

describe('a leaf certificate', () => {
  it('carries SANs and chains to the CA, because a CN alone is rejected outright', async () => {
    // Browsers have ignored commonName since Chrome 58: a cert with only a CN fails with
    // ERR_CERT_COMMON_NAME_INVALID however correct it otherwise is.
    const [, caCrt] = await ensureCa();
    const [certPem, keyPem] = await issueLeaf('x.houston.localhost');
    expect(certPem).toContain('BEGIN CERTIFICATE');
    expect(keyPem).toContain('PRIVATE KEY');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-leaf-test-'));
    try {
      const leaf = path.join(tmp, 'leaf.crt');
      fs.writeFileSync(leaf, certPem, 'utf8');
      const text = await describe_(leaf);
      expect(text).toContain('DNS:x.houston.localhost');
      // localhost and 127.0.0.1 too, so the existing http:// habits and any in-container
      // health check keep working against the same certificate.
      expect(text).toContain('DNS:localhost');
      expect(text).toContain('IP Address:127.0.0.1');
      // And it must actually CHAIN, not merely parse.
      const verified = await capture(['openssl', 'verify', '-CAfile', caCrt, leaf], {
        encoding: 'utf8',
        timeoutMs: 60_000,
      });
      expect(verified.exitCode).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it('sorts extra SANs into DNS and IP, and adds the defaults once', () => {
    // `subjectAltName` types are not interchangeable: an address written as `DNS:10.0.0.5`
    // does not match a browser connecting to that IP, and openssl rejects the reverse.
    const ext = leafExt('rc.test', ['10.0.0.5', 'alias.test', '  ', '::1']);
    expect(ext).toContain('DNS.1 = rc.test');
    expect(ext).toContain('DNS.2 = alias.test');
    expect(ext).toContain('DNS.3 = localhost');
    expect(ext).toContain('IP.1 = 10.0.0.5');
    expect(ext).toContain('IP.2 = ::1');
    expect(ext).toContain('IP.3 = 127.0.0.1');
    // Blank entries are dropped rather than emitted as an empty SAN openssl refuses.
    expect(ext).not.toMatch(/DNS\.\d+ = *$/mu);
    // The two defaults are added only when they are not already there. The check is
    // against the DEFAULTS and not across the caller's own list, so a caller that repeats
    // the host in `extraSans` gets it twice -- which openssl accepts and emits verbatim
    // (`DNS:localhost, DNS:localhost`), measured rather than assumed. Stated here because
    // it is what earlier releases did exactly, and this build keeps it.
    const again = leafExt('localhost', ['127.0.0.1', 'localhost']);
    expect([...again.matchAll(/DNS\.\d+ = localhost/gu)]).toHaveLength(2);
    expect([...again.matchAll(/IP\.\d+ = 127\.0\.0\.1/gu)]).toHaveLength(1);
    // The extensions themselves: serverAuth and not a second CA.
    expect(again).toContain('basicConstraints=CA:FALSE');
    expect(again).toContain('extendedKeyUsage=serverAuth');
  });
});

describe('a leaf for a name longer than a common name holds', () => {
  it('is issued with the name in its SANs and no common name', async () => {
    // A 51-character workspace name: openssl refused `/CN=<69 characters>` outright.
    const host = `${'a'.repeat(51)}.houston.localhost`;
    const [certPem] = await issueLeaf(host);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-leaf-test-'));
    try {
      const leaf = path.join(tmp, 'leaf.crt');
      fs.writeFileSync(leaf, certPem, 'utf8');
      const text = await describe_(leaf);
      expect(text).toContain(`DNS:${host}`);
      expect(text).not.toContain('CN = a');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('the manual instructions', () => {
  it('name the file and both directions, because trust is the part sudo may refuse', () => {
    const install = manualTrustInstructions('/tmp/houston/ca/ca.crt');
    expect(install).toContain('/tmp/houston/ca/ca.crt');
    expect(install).toContain('Install this file by hand');
    expect(manualTrustInstructions('/tmp/houston/ca/ca.crt', true)).toContain(
      'Remove this file by hand',
    );
    // And it says the warning is safe to click through: a repro is not a production site,
    // and a person stuck on trust has somewhere to go.
    expect(install).toContain('Or skip it');
  });
});

describe("a directory's certificate", () => {
  it("is issued for the service name Rocket.Chat dials, by houston's own CA", async () => {
    const { issueDirectoryCertificate } =
      require('../../src/core/lifecycle/tlsplan') as typeof TlsplanNS;
    const cert = await issueDirectoryCertificate();
    const [, caPath] = await ensureCa();
    expect(cert.ca).toBe(fs.readFileSync(caPath, 'utf8'));
    expect(cert.key).toContain('PRIVATE KEY');
    const file = path.join(os.tmpdir(), `houston-dir-${String(process.pid)}.crt`);
    fs.writeFileSync(file, cert.crt);
    try {
      const text = await describe_(file);
      expect(text).toContain('DNS:openldap');
      const verified = await capture(['openssl', 'verify', '-CAfile', caPath, file], {
        encoding: 'utf8',
      });
      expect(String(verified.stdout)).toContain(': OK');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
