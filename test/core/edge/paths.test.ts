/**
 * `core/edge/paths.ts` -- where the edge's files live -- and the certificate files that
 * land there.
 *
 * The claims `edge.test.ts` does not already make. The local certificates are REAL:
 * `issueLocalCert` runs openssl against a CA in this test's own HOUSTON_HOME. Docker is
 * replaced.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as config from '../../../src/lib/config';
import { ReproError } from '../../../src/lib/errors';
import { docker as dockerSeam } from '../../../src/seams/docker-cli';
import { ACME_FILE, acmeDir, recentIssuances, recordIssuance } from '../../../src/core/tls';

import { acmeHosts, issueLocalCert } from '../../../src/core/edge/acme';
import * as paths from '../../../src/core/edge/paths';
import { DYNAMIC_DIR } from '../../../src/core/edge/paths';
import { register } from '../../../src/core/edge/routes';
import { deleteHost } from '../../../src/core/edge/runtime';
import { traefikCommand, write } from '../../../src/core/edge/spec';
import { edge } from '../../../src/core/edge/types';

jest.mock('../../../src/seams/docker-cli', () => ({
  ...jest.requireActual('../../../src/seams/docker-cli'),
  docker: jest.fn(),
  compose: jest.fn(),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-edge-paths-'));
  process.env.HOUSTON_HOME = home;
  mocked(dockerSeam).mockImplementation((args: string[]) =>
    Promise.resolve({ argv: args, exitCode: 0, signal: null, stdout: '', stderr: '' }),
  );
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a local certificate', () => {
  it('is refused, not declared, when its directory cannot be written', async () => {
    // Docker creates a missing bind-mount target as ROOT, so `edge/certs` can be root-owned
    // while `edge/dynamic` is not. The declaration then landed and the certificate did not,
    // and Traefik retried the pair for ever -- "failed to find any PEM data", once a
    // second, serving nothing. Two such orphans were found on a live box.
    fs.mkdirSync(paths.certsDir(), { recursive: true });
    fs.mkdirSync(paths.dynamicDir(), { recursive: true });
    fs.chmodSync(paths.certsDir(), 0o555);
    try {
      // The scenario is a directory THIS USER cannot write, which a permission bit makes
      // real for anyone but root. Said, rather than skipped, if it does not hold.
      expect(writable(paths.certsDir())).toBe(false);
      const refused = issueLocalCert('w.houston.localhost');
      await expect(refused).rejects.toBeInstanceOf(ReproError);
      await expect(refused).rejects.toThrow('not writable');
      await expect(refused).rejects.toThrow('chown'); // give the fix, not just the fault
    } finally {
      fs.chmodSync(paths.certsDir(), 0o755);
    }
    // And nothing was declared, so there is no permanent error loop to explain.
    expect(
      fs.readdirSync(paths.dynamicDir()).filter((entry) => entry.startsWith('_cert-')),
    ).toEqual([]);
  });

  it('can be issued before any edge exists', async () => {
    // The first `up --https` on a fresh box: nothing had created the watched directory,
    // the atomic write puts its temp file beside the target, and `up --https` crashed.
    expect(fs.existsSync(paths.dynamicDir())).toBe(false);
    await issueLocalCert('w.houston.localhost');
    expect(fs.statSync(path.join(paths.certsDir(), 'w.houston.localhost.crt')).isFile()).toBe(true);
    const declaration = path.join(paths.dynamicDir(), '_cert-w.houston.localhost.yml');
    expect(fs.readFileSync(declaration, 'utf8')).toContain('certFile:');
  });
});

describe('the watched directory', () => {
  it('is a DIRECTORY, so registering is writing one file rather than editing a shared one', () => {
    // A single `--providers.file.filename` would make registration a rewrite of one shared
    // file, which cannot be done concurrently.
    const args = traefikCommand(edge({ domain: 'support.xyz.com', acmeEmail: 'ops@xyz.com' }));
    expect(args).toContain(`--providers.file.directory=/etc/traefik/${DYNAMIC_DIR}`);
    expect(args).toContain('--providers.file.watch=true');
    expect(args.some((arg) => arg.startsWith('--providers.file.filename'))).toBe(false);
  });
});

describe('forgetting a name', () => {
  it('removes everything a teardown left, and keeps the ACME account', async () => {
    const host = 't-1234.houston.localhost';
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    await register('t-1234', host, { local: true });
    await issueLocalCert(host);
    fs.mkdirSync(acmeDir(), { recursive: true });
    fs.writeFileSync(
      path.join(acmeDir(), ACME_FILE),
      JSON.stringify({
        le: {
          Account: { Email: 'ops@xyz.com' },
          Certificates: [{ domain: { main: host, sans: [] }, certificate: 'c', key: 'k' }],
        },
      }),
      'utf8',
    );

    const gone = await deleteHost(host, { confirm: true, restart: false });

    expect(gone.host).toBe(host);
    expect(gone.routes).toEqual(['t-1234']);
    expect(gone.certificate).toBe(true);
    expect(gone.declaration).toBe(true);
    expect(gone.acme).toEqual(['acme.json']);
    expect(fs.existsSync(path.join(paths.certsDir(), `${host}.crt`))).toBe(false);
    expect(fs.existsSync(path.join(paths.certsDir(), `${host}.key`))).toBe(false);
    expect(fs.existsSync(path.join(paths.dynamicDir(), `_cert-${host}.yml`))).toBe(false);
    expect(fs.existsSync(paths.routePath('t-1234'))).toBe(false);
    expect(acmeHosts()).toEqual([]);
    // The ACCOUNT is a registration with Let's Encrypt, not a certificate. Dropping it
    // makes the next issuance register again for nothing.
    const store = JSON.parse(fs.readFileSync(path.join(acmeDir(), ACME_FILE), 'utf8')) as {
      le: { Account: unknown };
    };
    expect(store.le.Account).toEqual({ Email: 'ops@xyz.com' });
  });
});

describe('where the edge lives', () => {
  it('lives outside the repro directory, straight under HOUSTON_HOME', () => {
    // `list`, `prune`, `down` and the GUI grid all enumerate the repros directory. Living
    // outside it is what makes the edge untouchable by them -- no guard code, just the
    // directory choice.
    const repros = config.reprosDir();
    const relative = path.relative(repros, paths.edgeDir());
    expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(true);
    expect(path.dirname(paths.edgeDir())).toBe(config.home());
  });
});

describe('the ACME store after a name is forgotten', () => {
  function writeGoneAcme(): void {
    fs.mkdirSync(acmeDir(), { recursive: true });
    fs.writeFileSync(
      path.join(acmeDir(), ACME_FILE),
      JSON.stringify({
        le: {
          Account: { Email: 'ops@xyz.com' },
          Certificates: [
            { domain: { main: 'gone.example.org', sans: [] }, certificate: 'c', key: 'k' },
          ],
        },
      }),
      'utf8',
    );
  }

  it('is rewritten still 0600, because it is a file full of private keys', async () => {
    // An atomic write takes its mode from the umask (0644), which is how a fix for one
    // exposure becomes another.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    writeGoneAcme();
    await deleteHost('gone.example.org', { confirm: true, restart: false });
    expect((fs.statSync(path.join(acmeDir(), ACME_FILE)).mode & 0o777).toString(8)).toBe('600');
  });

  it('keeps the issuance ledger, because a deleted certificate does not give the budget back', async () => {
    // `acme/issued.json` is the history `tls-status` counts against Let's Encrypt's
    // five-a-week duplicate limit; erasing it would make the count LIE.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    recordIssuance('gone.example.org');
    writeGoneAcme();
    const gone = await deleteHost('gone.example.org', { confirm: true, restart: false });
    expect(gone.kept).toEqual(['acme/issued.json']);
    expect(recentIssuances('example.org')).toBe(1);
  });
});
