import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../src/lib/config';
import { listPresets } from '../../src/lib/presets';
import { emptyPreset, type Preset } from '../../src/lib/presets/types';

import type { Invocation } from '../../src/cli/app';
import { renderHuman, renderPresets } from '../../src/cli/handlers';
import { COMMAND_SPECS } from '../../src/cli/spec-data';
import type { CommandSpec } from '../../src/cli/spec-types';

type Answer = { out: string; error: string | null };

/**
 * What earlier releases printed, recorded: `houston presets` over the corpus at each width
 * (`unset` is no COLUMNS, off a terminal), over the shipped catalogue at each width, and over
 * the user files of the ordering case; and `env`, `pat` and `monitor` for each of their cases,
 * in table order.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cli', 'render-human.json'), 'utf8'),
) as {
  presets: {
    corpus: Record<string, Answer>;
    catalogue: Record<string, Answer>;
    userFiles: Answer;
  };
  env: string[];
  pat: string[];
  monitor: string[];
};

function invocation(path: string, action = ''): Invocation {
  const spec = (COMMAND_SPECS as readonly CommandSpec[]).find(
    (candidate) => candidate.path === path,
  );
  if (spec === undefined) throw new Error(`unknown command path ${path}`);
  return {
    spec,
    arguments: action === '' ? {} : { action },
    options: {},
    events: null,
  };
}

function render(path: string, value: unknown, action = ''): { out: string; err: string } {
  let out = '';
  let err = '';
  renderHuman(invocation(path, action), value, {
    writeOut: (text) => {
      out += text;
    },
    writeErr: (text) => {
      err += text;
    },
  });
  return { out, err };
}

describe('explicit human command renderers', () => {
  test('all 40 routable paths have a renderer and none falls back to object JSON', () => {
    expect(COMMAND_SPECS).toHaveLength(40);
    for (const spec of COMMAND_SPECS) {
      const action = ['users', 'edge', 'config', 'cluster'].includes(spec.path) ? 'status' : '';
      const result = render(spec.path, { sentinel: 'must-not-be-a-json-dump' }, action);
      expect(result.out).not.toContain('"sentinel"');
      expect(result.out).not.toContain('{\n');
    }
  });

  test('list preserves the empty guidance and the stable human columns', () => {
    expect(render('list', { repros: [], count: 0 }).out).toBe(
      'No repros yet. Create one with `houston up --version <X.Y.Z>`.\n',
    );
    const shown = render('list', {
      repros: [
        {
          name: 'ticket-1',
          rc_version: '8.5.1',
          mongo_tag: '8.0',
          runtime: 'docker',
          host_port: 3000,
          state: 'running',
          root_url: 'http://127.0.0.1:3000',
          default: true,
        },
      ],
    }).out;
    expect(shown).toContain('NAME');
    expect(shown).toContain('RC');
    expect(shown).toContain('*ticket-1');
    expect(shown).toContain('* = default repro');
    expect(shown).not.toContain('"repros"');
  });

  test('token, PAT and API produce pasteable/raw output rather than serialized objects', () => {
    expect(render('token', { token: 'secret', user_id: 'uid' }).out).toBe(
      '-H "X-Auth-Token: secret" -H "X-User-Id: uid"\n',
    );
    expect(render('pat', { token: 'pat', user_id: 'uid', bypass_2fa: true }).out).toContain(
      '-H "X-Auth-Token: pat" -H "X-User-Id: uid"',
    );
    const api = render('api', {
      status: 404,
      auth: 'PAT',
      elapsed_ms: 12,
      text: '{"success":false}',
    }).out;
    expect(api).toBe('HTTP 404  [PAT]  in 12ms\n{"success":false}\n');
    // Earlier releases add a newline to one the body already has, and the elapsed time
    // turns to seconds at a second.
    expect(
      render('api', { status: 200, auth: 'admin', elapsed_ms: 1302.4, text: 'hello\n' }).out,
    ).toBe('HTTP 200  [admin]  in 1.30s\nhello\n\n');
  });

  test('loadtest draws nothing after the run, and says no warning again', () => {
    const result = render('loadtest', {
      ctx: { name: 'one', label: 'journey', vus: 10, duration: '30s' },
      summary: { count: 100, rps: 3.3, p95: 30, error_rate: 0.01 },
      slo: [{ ok: false, key: 'p95', op: '<=', raw: '20ms', actual: 30 }],
      passed: false,
      warnings: ['seed users unavailable'],
      saved_baseline: '/isolated/b.json',
      report: '/isolated/r.md',
    });
    // The result is drawn by the run itself, once it is measured and before anything is
    // saved, as earlier releases draw it; its warnings were said as they happened and only
    // kept for the envelope.
    expect(result).toEqual({ out: '', err: '' });
  });

  test('versions includes the pairing provenance and unknown-version note', () => {
    const result = render('versions', {
      rc_version: '8.5.999',
      rc_image: 'registry.example/rc',
      mongo_tag: '8.0',
      mongo_flavor: 'mongodb',
      mongo_shell: 'mongosh',
      oplog: false,
      source: 'map (no such release)',
      note: 'releases.rocket.chat has no 8.5.999',
    }).out;
    expect(result).toContain('shell: mongosh');
    expect(result).toContain('oplog url');
    expect(result).toContain('resolved via : map (no such release)');
    expect(result).toContain('note         : releases.rocket.chat has no 8.5.999');
  });

  test('cluster documents remain raw while status is human prose', () => {
    const guide = render('cluster', { body: '# Guide\nDo this.' }, 'guide').out;
    expect(guide).toBe('# Guide\nDo this.\n');
    const policy = render(
      'cluster',
      { documents: [{ name: 'operator', body: '{"Version":"2012-10-17"}' }] },
      'iam-policy',
    ).out;
    // An omitted document name is the menu, never an accidental object dump.
    expect(policy).toContain('operator');
    expect(policy).not.toContain('"documents"');
    const status = render(
      'cluster',
      {
        context: 'support',
        reachable: true,
        distribution: 'EKS',
        ours: true,
        nodes: 3,
        workspaces: [],
        pvcs: 0,
      },
      'status',
    ).out;
    expect(status).toContain('cluster   support');
    expect(status).toContain("EKS · houston's own · 3 node(s)");
  });
});

/**
 * `houston presets` against what earlier releases printed, with the preset list stated where
 * a corpus is given.
 *
 * An earlier version drew each box one line as long as its description and printed no `--set`
 * line and no `[needs license]`, because it read snake_case keys off a camelCase `Preset`.
 * Earlier releases size every box as the terminal's columns (90 off a terminal), capped at
 * 88, less 4 inside, so the widths below are the ones that change the answer: unset (no
 * terminal: 90, capped to 88), 100 and 88 (both capped), 60, 40, 20, 8, and 4, where the
 * wrap raises.
 */
describe('presets', () => {
  interface Row {
    name: string;
    description: string;
    params_help: Record<string, string>;
    requires_license: boolean;
  }
  const CORPUS: Row[] = [
    { name: 'plain', description: 'Short.', params_help: {}, requires_license: false },
    {
      name: 'folded',
      description:
        'Line one\n\tindented   words — and a well-known multi-instance-horizontal-scaling ' +
        "tail (bucket 'houston-uploads'), then “quotes” → arrows… and a\u0085NEL.",
      params_help: {},
      requires_license: false,
    },
    {
      name: 'licensed',
      description: 'Enterprise only.',
      params_help: {
        users: 'number of users to generate (default 5; try 130000 for scale)',
        idp_host:
          'hostname BOTH your browser and Rocket.Chat reach Keycloak on (default ' +
          "'keycloak', which needs a hosts entry and only works on this machine)",
        e: '',
        名前: '値 😀 with “quotes”',
      },
      requires_license: true,
    },
    { name: 'blank', description: '', params_help: {}, requires_license: false },
    {
      name: 'a-title-far-wider-than-any-box-this-command-could-ever-draw-at-any-width-at-all',
      description: `/tmp/-home-laborant-rc-repro/${'x'.repeat(90)}/file.yaml`,
      params_help: {},
      requires_license: false,
    },
  ];

  function toPreset(row: Row): Preset {
    return {
      ...emptyPreset(row.name),
      description: row.description,
      paramsHelp: row.params_help,
      requiresLicense: row.requires_license,
    };
  }

  function ours(presets: Preset[], columns: string | null): Answer {
    const host = {
      env: columns === null ? {} : { COLUMNS: columns },
      isatty: () => false,
      columns: () => null,
    };
    let out = '';
    try {
      renderPresets({ presets }, { writeOut: (text) => (out += text), writeErr: () => {} }, host);
      return { out, error: null };
    } catch (error) {
      return { out, error: `${(error as Error).name}: ${(error as Error).message}` };
    }
  }

  test('every box is wrapped as earlier releases wrapped it, at every width that changes it', () => {
    const widths = [null, '100', '88', '60', '40', '20', '8', '4'];
    const recorded = widths.map((columns) => RECORDED.presets.corpus[columns ?? 'unset']);
    widths.forEach((columns, at) => {
      expect([columns, ours(CORPUS.map(toPreset), columns)]).toEqual([columns, recorded[at]]);
    });
    // COLUMNS=4 leaves the wrap a width of 0: an `InvalidValue` after the heading, in both.
    expect(recorded[widths.indexOf('4')]).toEqual({
      out: 'Presets\n\n',
      error: 'InvalidValue: invalid width 0 (must be > 0)',
    });
  });

  test('the shipped catalogue, through renderHuman, reads the width from COLUMNS', () => {
    const widths = ['100', '60', '40'];
    const recorded = [null, ...widths].map(
      (columns) => RECORDED.presets.catalogue[columns ?? 'unset'],
    );
    // Unset needs a host with no terminal, which the real process may not be.
    expect(ours(listPresets(), null)).toEqual(recorded[0]);
    const saved = process.env.COLUMNS;
    try {
      widths.forEach((columns, at) => {
        process.env.COLUMNS = columns;
        const shown = render('presets', { presets: listPresets() });
        expect([columns, { out: shown.out, error: null }]).toEqual([columns, recorded[at + 1]]);
        expect(shown.err).toBe('');
      });
    } finally {
      if (saved === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = saved;
    }
    // What an earlier version never printed, named so a failure says which half regressed.
    expect(recorded[1]?.out).toContain('| --set verification   require email verification');
  });

  test("a user file's --set lines come in the file's order, and its box where a code-point sort puts it", () => {
    // A JavaScript object lists `"10"` and `"0"` before `users`; earlier releases keep the
    // order written. And UTF-16 sorts the astral emoji below U+FF21, where code points sort
    // it above.
    const files: readonly (readonly [string, string])[] = [
      [
        'ordered.yaml',
        'name: ordered\ndescription: Keys in the order written.\nparams_help:\n' +
          '  users: how many users\n  "10": ten\n  alpha: first letter\n  "0": zero\n',
      ],
      ['😀-emoji.yaml', 'name: 😀-emoji\ndescription: astral\n'],
      ['Ａ-fullwidth.yaml', 'name: Ａ-fullwidth\ndescription: above the surrogates\n'],
    ];
    const dir = config.presetDir();
    fs.mkdirSync(dir, { recursive: true });
    try {
      for (const [file, text] of files) fs.writeFileSync(path.join(dir, file), text, 'utf8');
      const recorded = RECORDED.presets.userFiles;
      expect(ours(listPresets(), null)).toEqual(recorded);
      const out = recorded.out;
      const box = out.slice(out.indexOf('+- ordered '));
      const keys = box
        .slice(0, box.indexOf('\n+-'))
        .split('\n')
        .filter((line) => line.startsWith('| --set '))
        .map((line) => line.split(/ +/u)[2]);
      expect(keys).toEqual(['users', '10', 'alpha', '0']);
      expect(out.indexOf('+- Ａ-fullwidth')).toBeLessThan(out.indexOf('+- 😀-emoji'));
    } finally {
      for (const [file] of files) fs.rmSync(path.join(dir, file), { force: true });
    }
  });
});

/**
 * `houston env` against what earlier releases printed with the current values and the write
 * answering the payload given.
 *
 * An earlier version marked a drifted row `!! NOT RUNNING` and printed neither drift warning, so a
 * recorded value the container is not running was shown with nothing saying what to do about it;
 * nor the `could not be read` note, the `--setting`/`--set` examples, or the `verify:` line after
 * an applied write. The examples carry `--name` only when one was typed, which is why each case
 * says whether it was.
 */
describe('env', () => {
  type Bag = Record<string, unknown>;
  const row = (key: string, value: string, override = false, drift = false): Bag => ({
    key,
    value,
    override,
    ...(drift ? { drift: true, live: '' } : {}),
  });
  // [what was typed as --name, the --set values (null for a read), the payload]
  const CASES: [string, string[] | null, Bag][] = [
    [
      'alpha',
      null,
      {
        name: 'alpha',
        env: [
          row('ADMIN_PASS', '********', false, true),
          row('FOO', 'bar', true, true),
          row('MONGO_URL', 'mongodb://mongodb:27017/rocketchat'),
          row('PORT', '3000', false, true),
        ],
        overrides: ['FOO'],
        drift: ['ADMIN_PASS', 'FOO', 'PORT'],
        live_read: true,
      },
    ],
    [
      'alpha',
      null,
      {
        name: 'alpha',
        env: [row('FOO', 'bar', true)],
        overrides: ['FOO'],
        drift: [],
        live_read: false,
      },
    ],
    [
      '',
      null,
      { name: 'alpha', env: [row('PORT', '3000')], overrides: [], drift: [], live_read: true },
    ],
    // Kubernetes: the container itself was asked, so there is no drift and no live_read.
    ['beta', null, { name: 'beta', env: [row('FOO', 'bar', true)], overrides: ['FOO'] }],
    [
      'alpha',
      ['A=1'],
      { name: 'alpha', restarted: true, overrides: [{ key: 'A', value: '1', removed: false }] },
    ],
    [
      '',
      ['A=1'],
      { name: 'alpha', restarted: false, overrides: [{ key: 'FOO', value: '', removed: true }] },
    ],
  ];

  function ours(typed: string, sets: string[] | null, result: Bag): string {
    const spec = (COMMAND_SPECS as readonly CommandSpec[]).find((item) => item.path === 'env');
    if (spec === undefined) throw new Error('no env command');
    let out = '';
    renderHuman(
      { spec, arguments: {}, options: { name: typed, set_: sets ?? [] }, events: null },
      result,
      { writeOut: (text) => (out += text), writeErr: () => {} },
    );
    return out;
  }

  test('the panel, the drift warnings and every hint line are those of earlier releases', () => {
    const recorded = RECORDED.env;
    // All at once, so a failure shows every case that differs rather than the first.
    expect(CASES.map(([typed, sets, result]) => ours(typed, sets, result))).toEqual(recorded);
    // What an earlier version never printed, named so a failure says which half regressed.
    expect(recorded[0]).toContain(
      '|  FOO         bar   <- yours   !! NOT IN THE RUNNING CONTAINER  |',
    );
    expect(recorded[0]).toContain(
      '  3 recorded value(s) are NOT what the container is running: ADMIN_PASS, FOO, PORT\n' +
        '  Rocket.Chat is using the old value. `houston env --set ADMIN_PASS=<value> --name alpha`',
    );
    expect(recorded[1]).toContain('  the container could not be read, so this is the recorded');
    expect(recorded[2]).toContain('  a raw env var:        houston env --set KEY=VALUE\n');
    expect(recorded[4]).toMatch(/ {2}verify: houston env --name alpha\n$/u);
    expect(recorded[5]).not.toContain('verify:');
  });
});

/**
 * `houston pat`'s two lines against what earlier releases printed with the workspace, the
 * login and the mint stubbed to the payload given. `bypass_2fa=` prints the bool as
 * `True`/`False`, where `display` wrote `true`/`false` on every successful mint; the name
 * and URL print what the record holds, which is not always text.
 */
describe('pat', () => {
  const ROWS = [
    { name: 'alpha', root_url: 'http://localhost:3100', bypass_2fa: true },
    { name: 'alpha', root_url: 'http://localhost:3100', bypass_2fa: false },
    { name: 123, root_url: null, bypass_2fa: true },
  ].map((row) => ({ ...row, token: 'pat-1', user_id: 'uid', label: 'houston' }));

  test('the header and the headers line are those of earlier releases, the flag as true or false', () => {
    const recorded = RECORDED.pat;
    expect(ROWS.map((row) => render('pat', row).out)).toEqual(recorded);
    expect(recorded[1]).toContain('(http://localhost:3100) — bypass_2fa=false\n');
  });
});

/**
 * `houston monitor`'s lines against what earlier releases printed with the service stubbed
 * to the payload given. The detach line dropped earlier releases'
 * ` (metrics setting left as-is — repro not reachable)` when `rc_setting_reset` was false,
 * the shared-stack note was reworded, and the attach line had no blank line after it.
 */
describe('monitor', () => {
  const grafana = 'http://localhost:5050';
  const CASES: [boolean, Record<string, unknown>][] = [
    [
      false,
      {
        name: 'alpha',
        monitoring: true,
        grafana_url: grafana,
        notes: [`Grafana:    ${grafana}  (admin/admin)`, 'Prometheus: http://localhost:9090'],
      },
    ],
    [
      false,
      {
        name: 'alpha',
        monitoring: true,
        grafana_url: grafana,
        notes: [
          `Grafana: ${grafana} (admin/admin)`,
          'the stack is SHARED by every workspace on this cluster',
        ],
      },
    ],
    [true, { name: 'alpha', monitoring: false, rc_setting_reset: true }],
    [true, { name: 'alpha', monitoring: false, rc_setting_reset: false }],
    [true, { name: 'alpha', monitoring: false, rc_setting_reset: true, stack_removed: false }],
    [true, { name: 'alpha', monitoring: false, rc_setting_reset: false, stack_removed: true }],
  ];

  function ours(off: boolean, result: Record<string, unknown>): string {
    const spec = (COMMAND_SPECS as readonly CommandSpec[]).find((item) => item.path === 'monitor');
    if (spec === undefined) throw new Error('no monitor command');
    let out = '';
    renderHuman({ spec, arguments: {}, options: { name: 'alpha', off }, events: null }, result, {
      writeOut: (text) => (out += text),
      writeErr: () => {},
    });
    return out;
  }

  test('the attach and detach lines, and the notes after them, are those of earlier releases', () => {
    const recorded = RECORDED.monitor;
    // All at once, so a failure shows every case that differs rather than the first.
    expect(CASES.map(([off, result]) => ours(off, result))).toEqual(recorded);
    expect(recorded[0]).toMatch(/^✓ monitoring attached to 'alpha'\n\nGrafana: /u);
    expect(recorded[3]).toBe(
      "✓ monitoring detached from 'alpha' (metrics setting left as-is — repro not reachable)\n",
    );
    expect(recorded[4]).toContain('other workspaces on this cluster are still using it\n');
  });
});
