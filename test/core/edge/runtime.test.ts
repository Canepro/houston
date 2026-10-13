/**
 * `core/edge/runtime.ts`: starting the edge lazily, moving legacy workspaces across, and
 * deleting a name without starting anything.
 *
 * "Resolving TLS never starts a container" drives `core/lifecycle`, so it lives in
 * `lifecycle.test.ts`. Docker is replaced, and each test has its own HOUSTON_HOME.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as YAML from 'yaml';

import { compose as composeSeam, docker as dockerSeam } from '../../../src/seams/docker-cli';
import { metadata, write as writeRecord } from '../../../src/core/runner/record';
import { ACME_FILE, acmeDir } from '../../../src/core/tls';

import { down } from '../../../src/core/edge/engine';
import * as paths from '../../../src/core/edge/paths';
import { registered } from '../../../src/core/edge/routes';
import { deleteHost, ensureRunning, up } from '../../../src/core/edge/runtime';
import { current, installed, write } from '../../../src/core/edge/spec';
import { edge } from '../../../src/core/edge/types';

jest.mock('../../../src/seams/docker-cli', () => ({
  ...jest.requireActual('../../../src/seams/docker-cli'),
  docker: jest.fn(),
  compose: jest.fn(),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

function answerEmpty(args: string[]) {
  return Promise.resolve({ argv: args, exitCode: 0, signal: null, stdout: '', stderr: '' });
}

/** What compose was asked, without the `-p houston_edge` every call carries. */
function composeVerbs(): string[] {
  return mocked(composeSeam).mock.calls.map(([args]) => (args as string[]).slice(2).join(' '));
}

/** A workspace holding 443 through its own Traefik. `tls` is what `adopt` checks. */
async function portHolding(name: string, host: string, tls: string): Promise<void> {
  await writeRecord(
    name,
    "services:\n  rocketchat:\n    image: rc\n  traefik:\n    image: traefik\n    ports: ['443:443']\n",
    metadata({
      name,
      project: `houston-${name}`,
      rcVersion: '8.5.1',
      publicUrl: `https://${host}`,
      extra: { tls, tls_ports: [443], tls_email: 'o@e.com' },
    }),
  );
}

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-edge-runtime-'));
  process.env.HOUSTON_HOME = home;
  // No edge is running (`ps` answers nothing) and every compose call succeeds.
  mocked(dockerSeam).mockImplementation(answerEmpty);
  mocked(composeSeam).mockImplementation(answerEmpty);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the lazy start', () => {
  it('writes a bare configuration on a box that has none, and no broken GUI route', async () => {
    // `up --https` on a box with no configuration at all has to produce a working edge.
    expect(installed()).toBe(false);
    expect((await ensureRunning()).ok).toBe(true);
    expect(installed()).toBe(true);
    expect(fs.existsSync(paths.routePath('_gui'))).toBe(false);
    expect(composeVerbs().some((verb) => verb.startsWith('up'))).toBe(true);
  });

  it('moves the others when one workspace will not move, and still starts', async () => {
    // Whatever still holds the port is named by `portHolder()`; one refusal must not stop
    // the rest, or the edge. `bad` sorts FIRST, so a refusal that escaped the loop would
    // leave `good` unmoved.
    await portHolding('bad', 't2.example.com', 'local'); // not a --domain workspace: refused
    await portHolding('good', 't1.example.com', 'acme');
    expect((await ensureRunning()).ok).toBe(true);
    expect(registered()).toEqual(['good']);
  });
});

/** Read the generation compose actually sees, rather than an expected argument list. */
function persistedCommand(): string[] {
  const doc = YAML.parse(fs.readFileSync(paths.composePath(), 'utf8')) as {
    services: { edge: { command: string[] } };
  };
  return doc.services.edge.command;
}

describe('concurrent shared edge operations', () => {
  it('serialises cold local and domain starts without losing the ACME resolver', async () => {
    let active = 0;
    let peak = 0;
    mocked(composeSeam).mockImplementation(async (args: string[]) => {
      if (!args.includes('up')) return await answerEmpty(args);
      active += 1;
      peak = Math.max(peak, active);
      // A real compose create takes time. Two overlapping creates own the same fixed
      // container name, independently of the different workspace locks their callers hold.
      const conflict = active > 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      active -= 1;
      return {
        argv: args,
        exitCode: conflict ? 1 : 0,
        signal: null,
        stdout: '',
        stderr: conflict ? 'container name houston_edge-edge-1 is already in use' : '',
      };
    });
    const starts = await Promise.all([
      ensureRunning(),
      ensureRunning({ acmeEmail: 'ops@example.test', acmeStaging: true }),
    ]);
    expect(starts.map((result) => result.ok)).toEqual([true, true]);
    expect(peak).toBe(1);
    expect(current()?.acmeEmail).toBe('ops@example.test');
    expect(persistedCommand()).toContain('--certificatesresolvers.le.acme.email=ops@example.test');
  });

  it('keeps one spec generation throughout compose while another writer waits', async () => {
    await write(edge({ acmeEmail: 'first@example.test' }));
    let entered!: () => void;
    const creating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let before: string[] = [];
    let after: string[] = [];
    mocked(composeSeam).mockImplementation(async (args: string[]) => {
      if (args.includes('up')) {
        before = persistedCommand();
        entered();
        await new Promise((resolve) => setTimeout(resolve, 100));
        after = persistedCommand();
      }
      return await answerEmpty(args);
    });
    const start = up({ pull: false });
    await creating;
    const changed = write(edge({ acmeEmail: 'second@example.test' }));
    await Promise.all([start, changed]);
    expect(after).toEqual(before);
    expect(current()?.acmeEmail).toBe('second@example.test');
  });

  it('finishes a compose start before a concurrent edge stop enters compose', async () => {
    await write(edge());
    let entered!: () => void;
    const creating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const events: string[] = [];
    mocked(composeSeam).mockImplementation(async (args: string[]) => {
      if (args.includes('up')) {
        events.push('start-in');
        entered();
        await new Promise((resolve) => setTimeout(resolve, 100));
        events.push('start-out');
      } else if (args.includes('down')) {
        events.push('stop');
      }
      return await answerEmpty(args);
    });
    const start = up({ pull: false });
    await creating;
    await Promise.all([start, down()]);
    expect(events).toEqual(['start-in', 'start-out', 'stop']);
  });
});

describe('deleting with the edge stopped', () => {
  it('does not start it: nothing can write the entry back while it is stopped', async () => {
    // Starting it would claim :443 as a side effect of a deletion.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    fs.mkdirSync(acmeDir(), { recursive: true });
    fs.writeFileSync(
      path.join(acmeDir(), ACME_FILE),
      JSON.stringify({ le: { Certificates: [{ domain: { main: 'gone.example.org' } }] } }),
      'utf8',
    );
    const gone = await deleteHost('gone.example.org', { confirm: true });
    expect(gone.acme).toEqual(['acme.json']); // so the restart question really was asked
    expect(gone.foreign).toBe('');
    expect(gone.restarted).toBeNull();
    expect(composeVerbs()).toEqual([]);
  });
});
