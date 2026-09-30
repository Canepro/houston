/**
 * `core/edge/spec.ts` -- what the edge writes about itself -- and the paths that read it
 * back: `deleteHost`, and doctor's edge rows.
 *
 * The deletion cases are the ones this module was written for: a name must come off EVERY place it
 * is held, the report must say only what actually went, and the three refusals must stop a deletion
 * that would break something the caller can still see.
 *
 * Docker is replaced throughout, and each test has its own HOUSTON_HOME.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as YAML from 'yaml';

import { runCli, type CliIo } from '../../../src/cli/app';
import { createExecutor } from '../../../src/cli/handlers';
import { ConflictError, ValidationError } from '../../../src/lib/errors';
import { compose as composeSeam, docker as dockerSeam } from '../../../src/seams/docker-cli';
import { checkEdge, type Ctx } from '../../../src/core/doctor';
import { ACME_FILE, ACME_FILE_STAGING, acmeDir } from '../../../src/core/tls';

import { acmeHosts, issueLocalCert } from '../../../src/core/edge/acme';
import * as paths from '../../../src/core/edge/paths';
import { SPEC_FILE } from '../../../src/core/edge/paths';
import { reattachAll, register, registered } from '../../../src/core/edge/routes';
import type * as RoutesNS from '../../../src/core/edge/routes';
import { deleteHost } from '../../../src/core/edge/runtime';
import { current, installed, servedDomain, write } from '../../../src/core/edge/spec';
import { edge, resolveEdge } from '../../../src/core/edge/types';

jest.mock('../../../src/seams/docker-cli', () => ({
  ...jest.requireActual('../../../src/seams/docker-cli'),
  docker: jest.fn(),
  compose: jest.fn(),
}));
// `registered` answers for real unless a test makes it fail: doctor's contract is that it
// runs when the environment is broken, and this is the one call the edge check cannot
// guard itself against.
jest.mock('../../../src/core/edge/routes', () => {
  const actual = jest.requireActual<typeof RoutesNS>('../../../src/core/edge/routes');
  return { ...actual, registered: jest.fn(actual.registered) };
});

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

/** Docker for an edge that is (or is not) up in this home; everything else answers empty. */
function scriptDocker({ running = false, holder = '' } = {}): void {
  mocked(dockerSeam).mockImplementation((args: string[]) => {
    const joined = args.join(' ');
    let stdout = '';
    if (joined.startsWith('ps') && joined.includes('{{.ID}}')) stdout = running ? 'c0ffee\n' : '';
    else if (joined.startsWith('ps') && joined.includes('{{.Names}}')) stdout = holder;
    else if (joined.includes('working_dir')) stdout = `${paths.edgeDir()}\n`;
    else if (joined.includes('NetworkSettings.Ports')) {
      stdout = '{"80/tcp":[{"HostPort":"80"}],"443/tcp":[{"HostPort":"443"}]}';
    }
    return Promise.resolve({ argv: args, exitCode: 0, signal: null, stdout, stderr: '' });
  });
  mocked(composeSeam).mockImplementation((args: string[]) =>
    Promise.resolve({ argv: args, exitCode: 0, signal: null, stdout: '', stderr: '' }),
  );
}

const STORE = {
  le: {
    Account: { Email: 'ops@xyz.com', PrivateKey: 'acct-key' },
    Certificates: [
      { domain: { main: 'gone.example.org', sans: [] }, certificate: 'c1', key: 'k1' },
      {
        domain: { main: 'keep.example.org', sans: ['www.keep.example.org'] },
        certificate: 'c2',
        key: 'k2',
      },
    ],
  },
};

function storeFile(staging: boolean): string {
  return path.join(acmeDir(), staging ? ACME_FILE_STAGING : ACME_FILE);
}

function writeAcme(staging = false): void {
  fs.mkdirSync(acmeDir(), { recursive: true });
  fs.writeFileSync(storeFile(staging), JSON.stringify(STORE), 'utf8');
}

function mains(staging: boolean): string[] {
  const doc = JSON.parse(fs.readFileSync(storeFile(staging), 'utf8')) as {
    le: { Certificates: { domain: { main: string } }[] };
  };
  return doc.le.Certificates.map((cert) => cert.domain.main);
}

const CTX: Ctx = { context: '', dockerUp: true, cloud: null, owned: null };

async function messages(status: string): Promise<string> {
  return (await checkEdge(CTX))
    .filter((row) => row.status === status)
    .map((row) => row.message)
    .join(' | ');
}

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = '';
  const io: CliIo = {
    writeOut: (value) => {
      out += value;
    },
    writeErr: (value) => {
      out += value;
    },
  };
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    return { code: await runCli(argv, { execute: createExecutor(io), io }), out };
  } finally {
    stdout.mockRestore();
  }
}

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-edge-spec-'));
  process.env.HOUSTON_HOME = home;
  scriptDocker();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('what the edge writes about itself', () => {
  it('records the domain it serves, readable by a different process', async () => {
    // `up` runs in a different process from the `serve` that set this up, and the port-443
    // error is far more useful when it can name what holds it.
    expect(servedDomain()).toBe('');
    await write(edge({ domain: 'support.xyz.com', acmeEmail: 'ops@xyz.com' }));
    expect(servedDomain()).toBe('support.xyz.com');
  });

  it('materialises the project: a compose file and the watched directory', async () => {
    await write(edge({ domain: 'support.xyz.com', acmeEmail: 'ops@xyz.com' }));
    expect(installed()).toBe(true);
    expect(fs.statSync(paths.dynamicDir()).isDirectory()).toBe(true);
    const doc = YAML.parse(fs.readFileSync(paths.composePath(), 'utf8')) as {
      services: Record<string, unknown>;
    };
    expect(doc.services.edge).toBeTruthy();
  });

  it('creates the certificate directory before compose can', async () => {
    // A bind-mount source that does not exist is created by Docker as ROOT, and houston
    // then cannot write certificates into it.
    await write(edge());
    expect(fs.statSync(paths.certsDir()).isDirectory()).toBe(true);
  });

  it('adds the GUI route when a bare edge is later given a domain', async () => {
    await write(edge());
    expect(fs.existsSync(paths.routePath('_gui'))).toBe(false);
    await write(edge({ domain: 'gui.example.com', acmeEmail: 'o@e.com' }));
    expect(fs.readFileSync(paths.routePath('_gui'), 'utf8')).toContain('Host(`gui.example.com`)');
  });

  it('rebuilds a resolved edge faithfully, and never fails a start on a bad spec', async () => {
    // `current()` reconstructed only the domain and the wildcard -- it dropped the email,
    // the GUI host and the GUI port, so `houston edge start` could not apply a changed
    // `acme.challenge` without pointing the front door at a GUI it no longer knew.
    await write(
      resolveEdge('gui.example.test', 'who@example.test', { guiHost: '172.17.0.1', guiPort: 9944 }),
    );
    const back = current();
    expect(back?.domain).toBe('gui.example.test');
    expect(back?.acmeEmail).toBe('who@example.test'); // the first thing lost
    expect(back?.guiHost).toBe('172.17.0.1'); // and the most damaging
    expect(back?.guiPort).toBe(9944);

    // An edge written before specs existed still reads back, at the old fidelity...
    fs.rmSync(path.join(paths.edgeDir(), SPEC_FILE));
    expect(current()?.domain).toBe('gui.example.test');
    // ...and garbage does not fail a start either.
    fs.writeFileSync(path.join(paths.edgeDir(), SPEC_FILE), '{not json', 'utf8');
    expect(current()).not.toBeNull();
  });

  it('reports nothing it could not join when nothing is registered', async () => {
    await write(edge());
    expect(await reattachAll()).toEqual([]);
  });
});

describe('deleting a name', () => {
  it('reports only what actually went, and says where a passthrough’s certificate is', async () => {
    // A name with a route and no certificate must not be reported as a certificate
    // deletion. Reporting the attempt as the outcome is the shape `edge stop` had.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    await register('k1', 'k1.example.org', { passthrough: '10.0.0.5:31443' });
    const gone = await deleteHost('k1.example.org', { confirm: true, restart: false });
    expect(gone.routes).toEqual(['k1']);
    expect(gone.passthrough).toEqual(['k1']);
    expect(gone.certificate).toBe(false);
    expect(gone.declaration).toBe(false);
    expect(gone.acme).toEqual([]);
    expect(gone.restarted).toBeNull(); // no ACME entry went, so nothing needed a restart
  });

  it('proceeds for a route whose workspace is gone, the case it exists for', async () => {
    // The orphan a teardown leaves: no workspace record, so the live-workspace refusal
    // must not fire.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    await register('ghost', 'ghost.example.org', { local: true });
    await issueLocalCert('ghost.example.org');
    const gone = await deleteHost('ghost.example.org', { confirm: true, restart: false });
    expect(gone.routes).toEqual(['ghost']);
    expect(gone.certificate).toBe(true);
  });

  it('refuses the GUI’s own name', async () => {
    // It would take `serve` off HTTPS while the operator is probably using it.
    await write(edge({ domain: 'support.xyz.com', acmeEmail: 'ops@xyz.com' }));
    const refused = deleteHost('support.xyz.com', { confirm: true, restart: false });
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toThrow("GUI's own name");
  });

  it('refuses without confirmation, and touches nothing', async () => {
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    await register('x', 'x.example.org', { local: true });
    await issueLocalCert('x.example.org');
    const refused = deleteHost('x.example.org', { restart: false });
    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    await expect(refused).rejects.toThrow('PRIVATE KEY');
    expect(fs.statSync(path.join(paths.certsDir(), 'x.example.org.crt')).isFile()).toBe(true);
  });

  it('needs a hostname, and says which command lists them', async () => {
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    const refused = deleteHost('  ', { confirm: true, restart: false });
    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    await expect(refused).rejects.toThrow('edge delete');
  });

  it('treats a trailing dot as the same name', async () => {
    // `example.org.` is how a resolver spells it and how a copy-paste arrives.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    await register('x', 'x.example.org', { local: true });
    expect((await deleteHost('x.example.org.', { confirm: true, restart: false })).routes).toEqual([
      'x',
    ]);
  });

  it('searches BOTH ACME stores, staging and production', async () => {
    // They are separate files. `config set acme.staging false` after a staging issuance
    // leaves the staging entry behind, and a delete that looked only at the live store
    // would report success over a key still on disk.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    writeAcme(false);
    writeAcme(true);
    expect(acmeHosts()).toEqual(['gone.example.org', 'keep.example.org', 'www.keep.example.org']);
    const gone = await deleteHost('gone.example.org', { confirm: true, restart: false });
    expect([...gone.acme].sort()).toEqual(['acme-staging.json', 'acme.json']);
    expect(mains(false)).toEqual(['keep.example.org']);
    expect(mains(true)).toEqual(['keep.example.org']);
  });

  it('finds and removes a name held only as a SAN', async () => {
    // A SAN is served exactly like a main name, so matching only `domain.main` would leave
    // the certificate presenting the deleted name.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    writeAcme();
    const gone = await deleteHost('www.keep.example.org', { confirm: true, restart: false });
    expect(gone.acme).toEqual(['acme.json']);
    expect(acmeHosts()).toEqual(['gone.example.org']);
  });

  it('matches a name by full Unicode case folding, so STRASSE.example is Straße.example', async () => {
    // Every host comparison in earlier releases is a full Unicode case fold, which folds ß to
    // ss; this lowered, which keeps ß, so `edge delete STRASSE.example` said "nothing here" and
    // kept the route and the certificate's private key earlier releases delete.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    await register('u1', 'Straße.example', { local: true });
    fs.mkdirSync(acmeDir(), { recursive: true });
    fs.writeFileSync(
      storeFile(false),
      JSON.stringify({
        le: { Certificates: [{ domain: { main: 'Straße.example', sans: ['ΣΟΦΟΣ.example'] } }] },
      }),
    );
    expect(acmeHosts()).toEqual(['strasse.example', 'σοφοσ.example']);
    const gone = await deleteHost('STRASSE.example', { confirm: true, restart: false });
    expect(gone.routes).toEqual(['u1']);
    expect(gone.acme).toEqual(['acme.json']);
    expect(registered()).toEqual([]);
  });

  it('refuses the GUI’s own name however its case folds', async () => {
    await write(edge({ domain: 'straße.xyz.com', acmeEmail: 'ops@xyz.com' }));
    const refused = deleteHost('STRASSE.xyz.com', { confirm: true, restart: false });
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toThrow("GUI's own name");
  });

  it('says so when the name is not here at all', async () => {
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    const gone = await deleteHost('nothing.example.org', { confirm: true, restart: false });
    expect(gone.routes).toEqual([]);
    expect(gone.acme).toEqual([]);
    expect(gone.certificate).toBe(false);
    expect(gone.declaration).toBe(false);
  });
});

describe('`houston edge delete` on the command line', () => {
  it('names the command that lists hosts when none was given', async () => {
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    const res = await cli(['edge', 'delete', '--yes']);
    expect(res.code).not.toBe(0);
    expect(res.out).toContain('edge status');
  });

  it('renders a refusal as a sentence, not a stack', async () => {
    // An uncaught ConflictError here was a stack trace with the CLI's own source in it --
    // the exact failure `edge start` shipped with.
    await write(edge({ domain: 'support.xyz.com', acmeEmail: 'ops@xyz.com' }));
    const res = await cli(['edge', 'delete', 'support.xyz.com', '--yes']);
    expect(res.code).not.toBe(0);
    expect(res.out).not.toMatch(/\n\s+at /u);
    expect(res.out).toContain("GUI's own name");
  });
});

describe('doctor’s edge rows', () => {
  it('reports a running edge, its name and its routes', async () => {
    await write(edge({ domain: 'support.xyz.com', acmeEmail: 'ops@xyz.com' }));
    await register('alice-rc8-5-1', 't1.support.xyz.com');
    scriptDocker({ running: true });
    const ok = await messages('ok');
    expect(ok).toContain('support.xyz.com');
    expect(ok).toContain('1 workspace route');
  });

  it('calls a stopped edge a FAILURE, because every name on the box is down with it', async () => {
    // Shared fate: while it is down the GUI and every registered workspace are
    // unreachable, and nothing else in the report would say so.
    await write(edge({ domain: 'support.xyz.com', acmeEmail: 'ops@xyz.com' }));
    await register('alice-rc8-5-1', 't1.support.xyz.com');
    scriptDocker({ running: false, holder: 'other-proxy\t0.0.0.0:443->443/tcp\n' });
    const failures = await messages('fail');
    expect(failures).toContain('NOT running');
    expect(failures).toContain('unreachable');
  });

  it('flags a route whose workspace is gone', async () => {
    // It points the edge at nothing, so that hostname 502s instead of 404ing and the name
    // cannot be reused.
    await write(edge({ domain: 'd', acmeEmail: 'e' }));
    await register('deleted-by-hand', 't9.support.xyz.com');
    scriptDocker({ running: true });
    expect(await messages('warn')).toContain('deleted-by-hand');
  });

  it('never breaks the report when the environment is broken', async () => {
    // doctor's contract: it must run when the environment is broken.
    await write(edge({ domain: 'd', acmeEmail: 'e' }));
    scriptDocker({ running: true });
    mocked(registered).mockImplementationOnce(() => {
      throw new RangeError('division by zero');
    });
    const rows = await checkEdge(CTX);
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows
        .filter((row) => row.status === 'warn')
        .map((row) => row.message)
        .join(' | '),
    ).toContain('could not be determined');
  });
});
