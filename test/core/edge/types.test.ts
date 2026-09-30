/**
 * `core/edge/types.ts`: building an edge from config, and what that puts on Traefik's
 * command line.
 *
 * `edge.test.ts` asserts what `resolveEdge` returns; these assert that it REACHES the edge -- the
 * switch that existed everywhere except the one component that requests certificates is the defect
 * this file is named after. Pure: config on disk, no Docker.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as config from '../../../src/lib/config';
import { acmeArgs } from '../../../src/core/tls';

import { composeDoc } from '../../../src/core/edge/spec';
import { asTlsSpec, edge, resolveEdge, type Edge } from '../../../src/core/edge/types';

function command(value: Edge): string[] {
  const doc = composeDoc(value) as unknown as { services: { edge: { command: string[] } } };
  return doc.services.edge.command;
}

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-edge-types-'));
  process.env.HOUSTON_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('acme.staging', () => {
  it('reaches the edge’s command line, into a SEPARATE store', () => {
    // Let's Encrypt allows five FAILED authorizations per name per hour, a support box has
    // a name per ticket, and every restart abandons an in-flight challenge -- so staging is
    // the only safe way to test the plumbing, and it was unreachable for the edge.
    config.saveConfig({ acme_staging: true });
    const door = resolveEdge('gui.example.test', 'a@b.test');
    expect(door.acmeStaging).toBe(true);
    const args = command(door);
    expect(args.some((arg) => arg.includes('acme-staging-v02.api.letsencrypt.org'))).toBe(true);
    // A separate store, so flipping back to production cannot serve a staging certificate.
    expect(args.some((arg) => arg.includes('acme-staging.json'))).toBe(true);

    // And production stays production when the switch is off.
    config.saveConfig({});
    const prod = resolveEdge('gui.example.test', 'a@b.test');
    expect(prod.acmeStaging).toBe(false);
    expect(command(prod).some((arg) => arg.includes('acme-staging'))).toBe(false);

    // An explicit value still wins over the config, for a caller that knows.
    expect(resolveEdge('gui.example.test', 'a@b.test', { acmeStaging: true }).acmeStaging).toBe(
      true,
    );
  });
});

describe('the challenge flags', () => {
  it('come from the workspace code path, so the two cannot drift', () => {
    // One implementation of the thing that decides whether issuance works at all.
    const door = edge({ domain: 'support.xyz.com', acmeEmail: 'ops@xyz.com' });
    const args = command(door);
    const wanted = acmeArgs(asTlsSpec(door));
    expect(wanted.length).toBeGreaterThan(0);
    for (const flag of wanted) expect(args).toContain(flag);
    expect(args).toContain('--certificatesresolvers.le.acme.email=ops@xyz.com');
  });

  it('select http-01 on request, and free :80 for it', () => {
    // A real box had NEITHER derived challenge: TLS-ALPN failed on every attempt and dns-01
    // needed a zone the operator did not have. http-01 was the one option left. And an
    // entryPoint redirect applies to every router on it -- measured: an explicit router
    // for `/.well-known/acme-challenge/` on `web` still answered 301 -- so it must go.
    config.saveConfig({ acme_challenge: 'http' });
    const door = resolveEdge('gui.example.test', 'a@b.test');
    expect(door.acmeChallenge).toBe('http');
    const args = command(door);
    expect(args).toContain('--certificatesresolvers.le.acme.httpchallenge=true');
    expect(args).toContain('--certificatesresolvers.le.acme.httpchallenge.entrypoint=web');
    expect(args.some((arg) => arg.includes('tlschallenge'))).toBe(false);
    expect(args.some((arg) => arg.includes('redirections'))).toBe(false);

    // The default is unchanged: TLS-ALPN, with all three redirect flags.
    config.saveConfig({});
    const plain = resolveEdge('gui.example.test', 'a@b.test');
    expect(plain.acmeChallenge).toBe('tlsalpn');
    const plainArgs = command(plain);
    expect(plainArgs.some((arg) => arg.includes('tlschallenge'))).toBe(true);
    expect(plainArgs.filter((arg) => arg.includes('redirections'))).toHaveLength(3);

    // A value nobody recognises falls back to the derivation rather than reaching Traefik,
    // where it would be a startup failure.
    config.saveConfig({ acme_challenge: 'banana' });
    expect(resolveEdge('g.example.test', 'a@b.test').acmeChallenge).toBe('tlsalpn');
  });
});
