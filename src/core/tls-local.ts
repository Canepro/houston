/**
 * houston's own certificate authority, for `up --https` without a domain.
 *
 * The offline path -- an openssl CA whose leaf certificates a browser only trusts after
 * `houston trust-ca`. The Let's Encrypt path shares nothing with it but the Traefik service
 * that serves the result.
 *
 * Everything here is local. Nothing in this file talks to a certificate authority over the
 * network.
 *
 * THE KUBERNETES TIER DEPENDS ON IT, and the dependency is real: `certmanager` puts this CA
 * into a cluster as a `ca` ClusterIssuer, so the Kubernetes tier cannot work without it.
 * The edge is not deferred: it is a plain import of the module it needs, which is pure
 * openssl and filesystem work with no seam of its own.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import * as config from '../lib/config';
import { ReproError } from '../lib/errors';
import { joinPath } from '../lib/home';
import { mkdirParents } from '../lib/mkdir-parents';
import { makeTempDir } from '../lib/tempdir';
import { capture } from '../seams/exec';

export const CA_DIR_NAME = 'ca';
export const CA_KEY = 'ca.key';
export const CA_CRT = 'ca.crt';

/** The root: made once, install once. */
const CA_DAYS = 3650;

/** A leaf: regenerated on every `up`, so this is generous. */
const LEAF_DAYS = 825;

const LINUX_ANCHORS: readonly (readonly [string, readonly string[]])[] = [
  // [directory, refresh command] — first one whose directory exists wins.
  ['/usr/local/share/ca-certificates', ['update-ca-certificates']], // Debian/Ubuntu
  ['/etc/pki/ca-trust/source/anchors', ['update-ca-trust', 'extract']], // Fedora/RHEL
];

const ANCHOR_NAME = 'houston-local-ca.crt';

export function caDir(): string {
  return joinPath(config.home(), CA_DIR_NAME);
}

/**
 * Run openssl, turning any failure into a user-facing error.
 *
 * openssl writes its real diagnosis to stderr and exits non-zero; surfacing that beats
 * "command failed", which is all the exit code says.
 */
async function openssl(args: readonly string[], { stdin }: { stdin?: string } = {}): Promise<void> {
  let result;
  try {
    result = await capture(['openssl', ...args] as [string, ...string[]], {
      encoding: 'utf8',
      timeoutMs: 60_000,
      ...(stdin !== undefined ? { input: stdin } : {}),
    });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException }).cause?.code === 'ENOENT'
    ) {
      throw new ReproError(
        'openssl not found - it generates the local CA for --https. Install it, or supply ' +
          'a certificate with --tls-cert/--tls-key.',
      );
    }
    throw new ReproError(`openssl failed: ${String(error)}`);
  }
  if (result.exitCode !== 0) {
    const detail = (String(result.stderr ?? '') || String(result.stdout ?? ''))
      .trim()
      .split('\n')
      .filter((line) => line !== '');
    throw new ReproError(
      `openssl ${String(args[0])} failed: ` +
        (detail.length > 0
          ? (detail[detail.length - 1] as string)
          : `exit ${String(result.exitCode)}`),
    );
  }
}

/**
 * Create the local CA if absent; return `[key, cert]`. Idempotent.
 *
 * One CA per machine, shared by every repro and never regenerated: it is what `trust-ca`
 * installs, so replacing it would silently invalidate that trust.
 */
export async function ensureCa(): Promise<[string, string]> {
  const directory = caDir();
  const key = joinPath(directory, CA_KEY);
  const crt = joinPath(directory, CA_CRT);
  if (fs.existsSync(key) && fs.existsSync(crt)) return [key, crt];

  // 0700 on the directory FIRST, so the key is never reachable even in the window below:
  // `openssl genrsa -out` creates the file at 0666 & ~umask and the chmod lands after it,
  // which on a default umask is a real, if brief, 0644 private key that can mint a
  // certificate for any name the browser will trust. The mode on the leaf only.
  mkdirParents(directory, 0o700);
  try {
    fs.chmodSync(directory, 0o700); // existing directory from an older houston
  } catch {
    /* a filesystem that cannot represent it */
  }
  await openssl(['genrsa', '-out', key, '4096']);
  fs.chmodSync(key, 0o600);
  await openssl([
    'req',
    '-x509',
    '-new',
    '-nodes',
    '-key',
    key,
    '-sha256',
    '-days',
    String(CA_DAYS),
    '-out',
    crt,
    '-subj',
    '/CN=houston local CA/O=houston',
  ]);
  return [key, crt];
}

function isIp(value: string): boolean {
  return net.isIP(value) !== 0;
}

/**
 * The x509 extension block for a leaf cert.
 *
 * SANs, not CN: browsers have ignored commonName since Chrome 58, so a cert with only a CN
 * is rejected with ERR_CERT_COMMON_NAME_INVALID.
 */
export function leafExt(host: string, extraSans: readonly string[]): string {
  const dns = [host];
  const ips: string[] = [];
  for (const raw of extraSans) {
    const value = raw.trim();
    if (value === '') continue;
    (isIp(value) ? ips : dns).push(value);
  }
  // localhost/127.0.0.1 too, so the existing http:// habits and any in-container health
  // check keep working against the same cert.
  if (!dns.includes('localhost')) dns.push('localhost');
  if (!ips.includes('127.0.0.1')) ips.push('127.0.0.1');
  const lines = [
    'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=@alt',
    '',
    '[alt]',
    ...dns.map((entry, index) => `DNS.${String(index + 1)} = ${entry}`),
    ...ips.map((entry, index) => `IP.${String(index + 1)} = ${entry}`),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Mint a leaf cert for `host`, signed by the local CA. Returns `[cert, key]` PEM.
 *
 * Written into the repro workspace by the caller, so it is disposable: `up` regenerates it
 * and `down --volumes` deleting it costs nothing. That is the opposite of the ACME case,
 * where losing state costs rate-limit budget.
 */
export async function issueLeaf(
  host: string,
  extraSans: readonly string[] = [],
): Promise<[string, string]> {
  const [caKey, caCrt] = await ensureCa();
  // A fresh temporary directory under `tempRoot()`, which falls back past a TMPDIR that
  // is gone where `os.tmpdir()` hands it over as given.
  const tmp = makeTempDir();
  try {
    const key = path.join(tmp, 'tls.key');
    const csr = path.join(tmp, 'tls.csr');
    const crt = path.join(tmp, 'tls.crt');
    const ext = path.join(tmp, 'ext.cnf');
    fs.writeFileSync(ext, leafExt(host, extraSans), 'utf8');
    await openssl(['genrsa', '-out', key, '2048']);
    // The name is in the SANs, which is all a browser reads. A common name holds at most 64
    // characters, and openssl refuses a longer one outright, so a long name goes without.
    const subject = host.length <= 64 ? `/CN=${host}` : '/O=houston';
    await openssl(['req', '-new', '-key', key, '-out', csr, '-subj', subject]);
    await openssl([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      caCrt,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-out',
      crt,
      '-days',
      String(LEAF_DAYS),
      '-sha256',
      '-extfile',
      ext,
    ]);
    return [fs.readFileSync(crt, 'utf8'), fs.readFileSync(key, 'utf8')];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Run a trust-store command, with sudo when not already root.
 *
 * Non-interactive (`sudo -n`): a CLI that silently blocks on a hidden password prompt looks
 * like a hang, so a missing sudo becomes the manual-instructions path.
 */
async function sudo(cmd: readonly string[]): Promise<{ code: number | null; stderr: string }> {
  const full = (process.getuid?.() === 0 ? [...cmd] : ['sudo', '-n', ...cmd]) as [
    string,
    ...string[],
  ];
  const result = await capture(full, { encoding: 'utf8', timeoutMs: 120_000 });
  return { code: result.exitCode, stderr: String(result.stderr ?? '') };
}

/** Install or remove the CA in the OS trust store. Returns `[done, description]`. */
export async function trust(caCrt: string, uninstall = false): Promise<[boolean, string]> {
  if (process.platform === 'darwin') {
    const cmd = uninstall
      ? ['security', 'remove-trusted-cert', '-d', caCrt]
      : [
          'security',
          'add-trusted-cert',
          '-d',
          '-r',
          'trustRoot',
          '-k',
          '/Library/Keychains/System.keychain',
          caCrt,
        ];
    try {
      const result = await sudo(cmd);
      return [result.code === 0, 'the macOS System keychain'];
    } catch (error) {
      return [false, `macOS System keychain (${String(error)})`];
    }
  }
  if (process.platform === 'linux') {
    for (const [anchorDir, refresh] of LINUX_ANCHORS) {
      if (!fs.existsSync(anchorDir) || !fs.statSync(anchorDir).isDirectory()) continue;
      const target = path.join(anchorDir, ANCHOR_NAME);
      try {
        let result = uninstall
          ? await sudo(['rm', '-f', target])
          : await sudo(['cp', caCrt, target]);
        if (result.code !== 0) {
          return [false, `${anchorDir} (need sudo: ${result.stderr.trim().slice(0, 60)})`];
        }
        result = await sudo(refresh);
        return [result.code === 0, `the system trust store (${anchorDir})`];
      } catch (error) {
        return [false, `${anchorDir} (${String(error)})`];
      }
    }
    return [false, 'no known trust-store directory on this Linux'];
  }
  return [false, String(process.platform)];
}

export function manualTrustInstructions(caCrt: string, uninstall = false): string {
  const verb = uninstall ? 'Remove' : 'Install';
  return (
    `\n  ${verb} this file by hand:\n` +
    `    ${caCrt}\n\n` +
    '  macOS:          Keychain Access -> System -> drag it in -> set to Always Trust\n' +
    '  Debian/Ubuntu:  sudo cp it into /usr/local/share/ca-certificates/ ' +
    '&& sudo update-ca-certificates\n' +
    '  Fedora/RHEL:    sudo cp it into /etc/pki/ca-trust/source/anchors/ ' +
    '&& sudo update-ca-trust extract\n' +
    '  Windows:        certutil -addstore -f Root <path>\n' +
    '  Firefox:        Settings -> Privacy & Security -> Certificates -> ' +
    'View Certificates -> Authorities -> Import\n\n' +
    '  Or skip it: the browser warning is safe to click through for a local repro.\n'
  );
}
