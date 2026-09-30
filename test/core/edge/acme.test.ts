/**
 * `core/edge/acme.ts`: the certificate material a route does not own.
 *
 * It states THE DEFECT as the thing that survives: route files are keyed by workspace name
 * and certificate material by hostname, so a teardown's `deregister` walks straight past all
 * of it. The local certificate is real (openssl, against this test's own CA); Docker is replaced.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { docker as dockerSeam } from '../../../src/seams/docker-cli';
import { ACME_FILE, acmeDir } from '../../../src/core/tls';

import { acmeFailure, acmeHosts, issueLocalCert, orphanCerts } from '../../../src/core/edge/acme';
import * as paths from '../../../src/core/edge/paths';
import { deregister, register } from '../../../src/core/edge/routes';
import { write } from '../../../src/core/edge/spec';
import { edge } from '../../../src/core/edge/types';

jest.mock('../../../src/seams/docker-cli', () => ({
  ...jest.requireActual('../../../src/seams/docker-cli'),
  docker: jest.fn(),
  compose: jest.fn(),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-edge-acme-'));
  process.env.HOUSTON_HOME = home;
  mocked(dockerSeam).mockImplementation((args: string[]) =>
    Promise.resolve({ argv: args, exitCode: 0, signal: null, stdout: '', stderr: '' }),
  );
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a teardown', () => {
  it('leaves the certificate, its private key and its ACME entry behind', async () => {
    // `orphanCerts` reports nothing, because it flags a declaration whose certificate is
    // MISSING, and here everything is present, valid and unreachable. The visible symptom
    // is a TLS handshake that succeeds, with a genuine certificate for the name, into a
    // 404 -- which is why `edge delete` exists.
    const host = 't-1234.houston.localhost';
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    await register('t-1234', host, { local: true });
    await issueLocalCert(host);
    fs.mkdirSync(acmeDir(), { recursive: true });
    fs.writeFileSync(
      path.join(acmeDir(), ACME_FILE),
      JSON.stringify({
        le: { Certificates: [{ domain: { main: host, sans: [] }, certificate: 'c', key: 'k' }] },
      }),
      'utf8',
    );

    deregister('t-1234'); // exactly what `down --volumes` calls

    expect(fs.statSync(path.join(paths.certsDir(), `${host}.crt`)).isFile()).toBe(true);
    expect(fs.statSync(path.join(paths.certsDir(), `${host}.key`)).isFile()).toBe(true);
    expect(fs.statSync(path.join(paths.dynamicDir(), `_cert-${host}.yml`)).isFile()).toBe(true);
    expect(acmeHosts()).toEqual([host]);
    expect(orphanCerts()).toEqual([]); // the wrong direction: it finds MISSING certificates
  });
});

/**
 * The refusal line Traefik logged, as earlier releases extract it: split at every Unicode
 * line break, whitespace folded to single spaces, cut at 400 CODE POINTS. `slice` cut 400
 * UTF-16 units -- half as many emoji, ending in a lone surrogate.
 */
describe('the ACME refusal, as earlier releases read it', () => {
  it('is folded and cut as earlier releases fold and cut it', async () => {
    const reason = `DNS problem: ${'😀'.repeat(390)} tail`;
    const logs =
      'edge-1  | time="x" level=info msg="starting"\r\n' +
      `edge-1  | time="y" level=error msg="Unable to obtain ACME certificate" error="${reason}\\n  second\\u0085third"\n`;
    const { compose } = jest.requireMock('../../../src/seams/docker-cli') as { compose: jest.Mock };
    compose.mockResolvedValue({ argv: [], exitCode: 0, signal: null, stdout: logs, stderr: '' });
    const ours = await acmeFailure();
    // What earlier releases extracted from the same log, recorded: the reason up to the 387th
    // emoji, 400 code points in all.
    const recorded = `DNS problem: ${'😀'.repeat(387)}`;
    expect([...recorded].length).toBe(400);
    expect(ours).toBe(recorded);
  });
});
