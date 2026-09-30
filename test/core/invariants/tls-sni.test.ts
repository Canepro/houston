/**
 * INVARIANT: `verify` presents the name it was asked to, not the address it dialled.
 *
 * MECHANISM: BEHAVIOURAL, observed at the other end of the handshake.
 *
 * Earlier releases asserted that the source of `verify` passes the server name as the SNI and
 * never the host. `test/core/tls.test.ts` has a test of the same name
 * that dials 127.0.0.1 with an SNI -- and it passes with the SNI thrown away, because the
 * test server has ONE certificate and serves it whatever name is asked for. This asks the
 * server what name it was given, which is the only thing the claim is about.
 *
 * `tls-status` is why it matters: probing loopback while presenting the workspace's name is
 * how this box is asked what IT serves for that name, without a proxy in front answering
 * instead.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tlsSocket from 'node:tls';
import { spawnSync } from 'node:child_process';

import * as tls from '../../../src/core/tls';

describe('a TLS probe', () => {
  let server: tlsSocket.Server | undefined;
  let port = 0;
  const asked: (string | undefined)[] = [];
  let dir = '';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-sni-'));
    const key = path.join(dir, 'k.pem');
    const crt = path.join(dir, 'c.pem');
    // A throwaway self-signed pair. `openssl` is already a dependency of the local-CA
    // path, so this needs nothing the tree does not already require.
    const made = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        crt,
        '-days',
        '1',
        '-subj',
        '/CN=probe.example.test',
      ],
      { encoding: 'utf8' },
    );
    if (made.status !== 0) throw new Error(`could not mint a test certificate: ${made.stderr}`);
    server = tlsSocket.createServer({
      key: fs.readFileSync(key),
      cert: fs.readFileSync(crt),
      SNICallback: (servername, callback) => {
        // WHAT THE SERVER WAS TOLD. With the SNI discarded this is `undefined`, and the
        // handshake still succeeds -- which is exactly why asserting on the certificate
        // that comes back proves nothing.
        asked.push(servername);
        callback(null);
      },
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server === undefined) return resolve();
      server.close(() => resolve());
    });
    if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
  });

  it('presents the requested SNI while dialling the address it was given', async () => {
    asked.length = 0;
    const report = await tls.verify('127.0.0.1', { port, timeout: 5, sni: 'sni.example.test' });
    expect(report.serving).toBe(true);
    expect(report.host).toBe('127.0.0.1');
    expect(asked).toContain('sni.example.test');
  });

  it('presents the host itself when no SNI is asked for', async () => {
    asked.length = 0;
    const report = await tls.verify('localhost', { port, timeout: 5 });
    expect(report.serving).toBe(true);
    expect(asked).toContain('localhost');
  });
});
