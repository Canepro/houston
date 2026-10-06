/** Job results refresh the document's allow-list after public monitoring attaches. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function gui() {
  const closed: (() => void)[] = [];
  const reload = jest.fn();
  const nodes = {
    '#job-title': { textContent: '' },
    '#job-log': { append: jest.fn(), scrollTop: 0, scrollHeight: 0 },
    '#job-dialog': {
      addEventListener: jest.fn((_event: string, callback: () => void, options: unknown) => {
        expect(options).toEqual({ once: true });
        closed.push(callback);
      }),
    },
  };
  const ctx = {
    $: (selector: keyof typeof nodes) => nodes[selector],
    el: jest.fn(),
    loadRepros: jest.fn(async () => undefined),
    refreshDetail: jest.fn(),
  };
  const source = fs
    .readFileSync(path.resolve(__dirname, '../../data/webui/js/jobs.js'), 'utf8')
    .replace(/^import .*;$/mu, '')
    .replace(/^export .*;$/mu, '');
  const sandbox = vm.createContext({ ctx, location: { reload } });
  vm.runInContext(source, sandbox);
  const finish = vm.runInContext('finishJob', sandbox) as (
    job: Record<string, unknown>,
    failed: boolean,
    data: Record<string, unknown>,
  ) => void;
  return { finish, reload, closed, ctx };
}

describe('Grafana public URL regression: GUI reload', () => {
  it.each([
    { monitoring: true, grafana_url: 'https://rc.example.test/grafana' },
    { monitoring: { grafana_url: 'https://rc.example.test/grafana' } },
  ])('reloads after the successful result is closed: %j', (result) => {
    const { finish, reload, closed } = gui();
    finish({}, false, { result });
    expect(reload).not.toHaveBeenCalled();
    expect(closed).toHaveLength(1);
    closed[0]?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

it('keeps loopback and failed results on the current page', () => {
  const { finish, closed, reload } = gui();
  finish({}, false, { result: { monitoring: true, grafana_url: 'http://localhost:5050' } });
  finish({}, true, {
    result: { monitoring: true, grafana_url: 'https://rc.example.test/grafana' },
  });
  finish({}, false, { result: { grafana_url: 'https://rc.example.test/grafana' } });
  expect(closed).toEqual([]);
  expect(reload).not.toHaveBeenCalled();
});
