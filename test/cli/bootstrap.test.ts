/**
 * The CLI bootstrap leases ONE durable event sink for the command's life, and gives it back.
 *
 * An event emitted while the command runs lands in the log exactly once -- not twice from a
 * second lease, not zero from none -- and an event emitted after `runMain` returns does not
 * land at all, because a lease left installed would keep writing for whatever the process
 * does next.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as EventlogNS from '../../src/core/eventlog';
import type * as EventsNS from '../../src/lib/events';
import type * as HandlersNS from '../../src/cli/handlers';

let home = '';
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.HOUSTON_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-bootstrap-'));
  process.env.HOUSTON_HOME = home;
});
afterEach(() => {
  jest.dontMock('../../src/cli/app');
  jest.resetModules();
  process.env.HOUSTON_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
});

it('owns one durable event sink for the command, and releases it after', async () => {
  jest.resetModules();
  jest.doMock('../../src/cli/app', () => ({
    ...jest.requireActual('../../src/cli/app'),
    runCli: async () => {
      const events = require('../../src/lib/events') as typeof EventsNS;
      events.info(events.nullEmit, 'cli-bootstrap-event');
      return 0;
    },
  }));
  const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
  const eventlog = require('../../src/core/eventlog') as typeof EventlogNS;
  const events = require('../../src/lib/events') as typeof EventsNS;
  eventlog.resetForTest();

  expect(await handlers.runMain(['list'])).toBe(0);
  await eventlog.settle();
  const logged = fs.readFileSync(eventlog.logPath(), 'utf8');
  expect(logged.split('cli-bootstrap-event').length - 1).toBe(1);

  events.info(events.nullEmit, 'after-cli-lifecycle');
  await eventlog.settle();
  expect(fs.readFileSync(eventlog.logPath(), 'utf8')).toBe(logged);
});
