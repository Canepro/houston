/**
 * Three terminal renderers against what earlier releases printed for the same input, byte
 * for byte.
 *
 * Each once diverged from earlier releases:
 *  - progress events: every event was printed, where earlier releases drop terminal events
 *    and `done` info lines, indent two, and send warnings to stderr;
 *  - resource rows: keyed by the full container name and unsorted, where earlier releases
 *    print `rocketchat-1`/`mongodb`, sorted, with RAM in MB and its delta;
 *  - workspace notes: never wrapped, never ASCII, rows unaligned, where earlier releases wrap
 *    prose to the terminal (never a command) and align the facts.
 *
 * The recorded side is what earlier releases wrote to stdout and stderr for the same input
 * at 88 columns; the other calls this build's renderer. Nothing else is involved.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { metadata } from '../../../src/core/runner/record';
import { COMMAND_SPECS } from '../../../src/cli/spec-data';
import type { Invocation } from '../../../src/cli/app';

import { emitOf, printNotes, renderResources } from '../../../src/cli/handlers';

interface Printed {
  stdout: string;
  stderr: string;
}

/**
 * What earlier releases printed, recorded: the progress events, the resource rows, and the
 * notes for each record by its label. The notes were recorded in a sandboxed home, which is
 * kept as `<home>` and put back from this run's.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'cli', 'handlers', 'render-output.json'),
    'utf8',
  ),
) as { events: Printed; resources: Printed; notes: Record<string, Printed> };

function inThisHome(printed: Printed | undefined): Printed | undefined {
  if (printed === undefined) return undefined;
  const home = process.env.HOUSTON_HOME ?? '';
  return {
    stdout: printed.stdout.replaceAll('<home>', home),
    stderr: printed.stderr.replaceAll('<home>', home),
  };
}

async function captured(
  write: (io: {
    writeOut: (t: string) => void;
    writeErr: (t: string) => void;
  }) => void | Promise<void>,
) {
  let stdout = '';
  let stderr = '';
  await write({
    writeOut: (text) => {
      stdout += text;
    },
    writeErr: (text) => {
      stderr += text;
    },
  });
  return { stdout, stderr };
}

let columns: string | undefined;
beforeEach(() => {
  columns = process.env.COLUMNS;
  process.env.COLUMNS = '88';
});
afterEach(() => {
  process.env.COLUMNS = columns;
});

it('prints progress events exactly as earlier releases did', async () => {
  const events = [
    { message: 'pulling images', phase: 'pull', level: 'info', terminal: false },
    { message: 'info-done', phase: 'done', level: 'info', terminal: false },
    { message: 'warn-done', phase: 'done', level: 'warn', terminal: false },
    { message: 'terminal-warn', phase: 'teardown', level: 'warn', terminal: true },
    { message: 'error line', phase: 'create', level: 'error', terminal: false },
  ];
  const recorded = RECORDED.events;
  const spec = COMMAND_SPECS.find((one) => one.path === 'ready');
  const invocation = { spec, arguments: {}, options: {}, events: null } as unknown as Invocation;
  const ours = await captured((io) => {
    const emit = emitOf(invocation, io);
    for (const event of events) emit(event as Parameters<typeof emit>[0]);
  });
  expect(ours).toEqual(recorded);
});

it('prints resource rows exactly as earlier releases did', async () => {
  const rows = {
    'houston-x-rocketchat-1': { idle_cpu: 1.5, peak_cpu: 88.5, idle_mem: 400e6, peak_mem: 812.4e6 },
    'houston-x-rocketchat-2': { idle_cpu: 2, peak_cpu: 40, idle_mem: 380e6, peak_mem: 700e6 },
    'houston-x-mongodb-1': { idle_cpu: 0.4, peak_cpu: 12, idle_mem: 150e6, peak_mem: 260e6 },
    'houston-x-nats-1': { idle_cpu: 0, peak_cpu: 1, idle_mem: 10e6, peak_mem: 12e6 },
  };
  const recorded = RECORDED.resources;
  const ours = await captured((io) => {
    renderResources(rows, io, 'x');
  });
  expect(ours).toEqual(recorded);
});

describe('workspace notes', () => {
  const records: [string, Record<string, unknown>][] = [
    [
      'a recorded flat note with a long prose line and a command',
      {
        preset: 'default',
        extra: {
          notes: [
            'bring the forward back with:',
            '    kubectl -n houston-a-fairly-long-workspace-name port-forward deployment/rocketchat-rocketchat 3000:3000',
            '`stats` needs metrics-server in the cluster — '.repeat(3),
          ],
        },
      },
    ],
    [
      'the Kubernetes groups, with a middle-dot step heading',
      {
        preset: 'default',
        extra: {
          runtime: 'kubernetes',
          deployment: 'microservices',
          namespace: 'houston-old',
          context: 'kind-houston-local',
          release: 'rocketchat',
          bind_host: '127.0.0.1',
          mongo_managed_by: 'statefulset',
          mongo_image: 'mongo:8.0',
        },
      },
    ],
    ['a scenario preset', { preset: 'oidc', extra: {} }],
  ];

  it.each(records)('renders %s exactly as earlier releases did', async (label, values) => {
    // Earlier releases printed the recorded notes from this same record, as its repro.json
    // spells it: `old`, 8.5.1 on MongoDB 8.0, at http://localhost:3000, plus `values`.
    const recorded = inThisHome(RECORDED.notes[label]);
    const meta = metadata({
      name: 'old',
      project: 'houston-old',
      rcVersion: '8.5.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: String(values.preset),
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 'map',
      extra: values.extra as Record<string, unknown>,
    });
    const ours = await captured(async (io) => {
      await printNotes(meta, io);
    });
    expect(ours).toEqual(recorded);
  });
});
