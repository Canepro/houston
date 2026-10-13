/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import sse from '@fastify/sse';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import * as audit from '../../../src/core/audit';
import * as users from '../../../src/core/users';
import { runWithContext } from '../../../src/lib/context';
import { event } from '../../../src/lib/events';
import { ValidationError } from '../../../src/lib/errors';
import { installJobs, JobManager, MAX_JOBS, type Job } from '../../../src/web/jobs';
import { register as registerJobRoutes } from '../../../src/web/routes/jobs';

const assets = path.resolve(__dirname, '../../../data/webui');

// The job registry, its role filtering and terminal SSE events are production
// code. Only the unrelated dashboard probes are HTTP fixtures.
describe('retained job output in History', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let app: FastifyInstance;
  let manager: JobManager;
  let origin = '';
  const pageErrors: string[] = [];

  beforeAll(async () => {
    await users.add('alice', 'History-test-password-1', 'member');
    browser = await chromium.launch();
  });

  beforeEach(async () => {
    fs.rmSync(audit.auditPath(), { force: true });
    pageErrors.length = 0;
    manager = new JobManager();
    app = Fastify({ logger: false });
    app.decorateRequest('houstonActor', '');
    app.addHook('onRequest', async (request) => {
      request.houstonActor = 'alice';
    });
    await app.register(sse);
    installJobs(app, { manager });
    registerJobRoutes(app);
    app.get('/', async (_request, reply) =>
      reply.type('text/html').send(fs.readFileSync(path.join(assets, 'index.html'))),
    );
    app.get('/app.css', async (_request, reply) =>
      reply.type('text/css').send(fs.readFileSync(path.join(assets, 'app.css'))),
    );
    app.get('/js/:file', async (request, reply) => {
      const { file } = request.params as { file: string };
      return reply
        .type('text/javascript')
        .send(fs.readFileSync(path.join(assets, 'js', path.basename(file))));
    });
    app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());
    app.get('/api/audit', async (request) => {
      const { q } = request.query as { q?: string };
      return audit.read({ actorName: 'alice', limit: 200, ...(q === undefined ? {} : { q }) });
    });
    app.get('/api/*', async (request) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/api/repros') return { repros: [] };
      if (pathname === '/api/session') return { accounts: true, user: 'alice', role: 'member' };
      if (pathname === '/api/health') return { docker: true };
      if (pathname === '/api/kubernetes') return { usable: false, tools_ready: false };
      if (pathname === '/api/edge') return { installed: false, running: false, routes: [] };
      if (pathname === '/api/clusters') return { contexts: [], unreadable: '', default: '' };
      if (pathname === '/api/clusters/overview') return { clusters: [], failed: [], preflight: {} };
      if (pathname === '/api/clusters/connection') return { error: '', profiles: [] };
      if (pathname === '/api/settings') return { may_set_privileged: false };
      if (pathname === '/api/machine')
        return { known: true, room: 2, total_mb: 8192, available_mb: 4096, reserve_mb: 1024 };
      if (pathname === '/api/presets') return { presets: [] };
      if (pathname === '/api/backups') return { backups: [] };
      return {};
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    origin = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
    context = await browser.newContext({ baseURL: origin });
    page = await context.newPage();
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });
  });

  afterEach(async () => {
    await context.close();
    await app.close();
    expect(pageErrors).toEqual([]);
    expect(app.server.listening).toBe(false);
  });

  afterAll(async () => {
    await browser.close();
  });

  async function settled(job: Job): Promise<void> {
    for (let tries = 0; tries < 100 && ['queued', 'running'].includes(job.status); tries += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(['done', 'error']).toContain(job.status);
  }

  async function seed(label = 'alice-seed', actor = 'alice'): Promise<Job> {
    const job = runWithContext({ actor, origin: 'session' }, () =>
      manager.submit(
        'seed',
        (emit) => {
          emit(event('seed progress remains readable', { phase: 'seed' }));
          return {
            users: 2,
            messages: 7,
            threads: 1,
            rooms_total: 3,
            planned: { users: 2, messages: 7, threads: 1, rooms_total: 3, files: 0 },
          };
        },
        { label },
      ),
    );
    await settled(job);
    return job;
  }

  async function historyAfterRefresh(): Promise<void> {
    await page.goto('/#/activity/history');
    await page.locator('#act-tab-history.active').waitFor();
    await page.reload();
    await page.locator('#act-tab-history.active').waitFor();
    await page.waitForFunction(
      () => document.querySelector('#jobs-list')?.textContent !== 'loading…',
    );
    expect(new URL(page.url()).hash).toBe('#/activity/history');
  }

  test('a retained completed job reopens its result from History after refresh', async () => {
    const job = await seed();
    await historyAfterRefresh();
    const row = page.locator(`button[data-job-id="${job.id}"]`);
    await row.waitFor();
    expect(await row.locator('.jstatus').textContent()).toBe('done');
    await row.click();
    await page.waitForFunction(() => document.querySelector('#job-title')?.textContent === 'Done');
    expect(await page.locator('#job-log').innerText()).toContain('Seeded: 2 users · 7 messages');
    expect(await page.locator('#job-log').innerText()).toContain('Planned: 2 users · 3 rooms');
  });

  test('a retained failed job reopens its reason and records failure separately from acceptance', async () => {
    const job = runWithContext({ actor: 'alice', origin: 'session' }, () =>
      manager.submit(
        'scale',
        () => {
          throw new ValidationError('this workspace cannot use compose scaling');
        },
        { label: 'alice-failed' },
      ),
    );
    await settled(job);
    await historyAfterRefresh();
    const row = page.locator(`button[data-job-id="${job.id}"]`);
    await row.waitFor();
    expect(await row.locator('.jstatus').textContent()).toBe('failed');
    const recorded = page
      .locator('#jobs-list div.jobrow')
      .filter({ hasText: 'scale: alice-failed' });
    expect(await recorded.locator('.jstatus').allTextContents()).toEqual(['failed', 'accepted']);
    await row.click();
    await page.waitForFunction(
      () => document.querySelector('#job-title')?.textContent === 'Failed',
    );
    expect(await page.locator('#job-log').innerText()).toContain(
      'this workspace cannot use compose scaling',
    );
  });

  test('released full output is identified while retained progress can still be reopened', async () => {
    const job = await seed();
    job.forgetResult();
    await historyAfterRefresh();
    const row = page.locator(`button[data-job-id="${job.id}"]`);
    await row.waitFor();
    expect(await row.innerText()).toContain('Full output has expired');
    await row.click();
    await page.waitForFunction(() => document.querySelector('#job-title')?.textContent === 'Done');
    const text = await page.locator('#job-log').innerText();
    expect(text).toContain("This job's full output has expired");
    expect(text).toContain('seed progress remains readable');
    expect(text).not.toContain('Seeded:');
  });

  test('a job evicted after History loads has a readable unavailable-output response', async () => {
    const job = await seed();
    await historyAfterRefresh();
    const row = page.locator(`button[data-job-id="${job.id}"]`);
    await row.waitFor();
    for (let index = 0; index < MAX_JOBS; index += 1) {
      const next = manager.submit('state', () => null, {
        actor: 'alice',
        label: `retention-${String(index)}`,
      });
      await settled(next);
    }
    expect(manager.get(job.id)).toBeUndefined();
    const refusal = page.waitForResponse(
      (response) => response.url() === `${origin}/api/jobs/${job.id}`,
    );
    await row.click();
    const response = await refusal;
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({ error: 'no such job' });
    await page.waitForFunction(
      () => document.querySelector('#job-title')?.textContent === 'Output unavailable',
    );
    expect(await page.locator('#job-log').innerText()).toContain(
      'Its recorded activity remains in History',
    );
    expect(await page.locator('#job-stop').isHidden()).toBe(true);
  });

  test('History preserves member scoping and old audit entries without promising retained output', async () => {
    const own = await seed('alice-own');
    const other = await seed('bob-private', 'bob');
    audit.audit('alice', 'seed', 'old-seed', { origin: 'session', outcome: 'ok' });
    await historyAfterRefresh();
    await page.locator(`button[data-job-id="${own.id}"]`).waitFor();
    expect(await page.locator(`button[data-job-id="${other.id}"]`).count()).toBe(0);
    expect(await page.locator('#jobs-list').innerText()).not.toContain('bob-private');
    const legacy = page.locator('#jobs-list div.jobrow').filter({ hasText: 'old-seed' });
    expect(await legacy.locator('.jstatus').textContent()).toBe('seed');
    expect(await page.locator('#jobs-list').innerText()).toContain(
      'cleared when this server restarts',
    );
    await page.locator('#act-denied').check();
    await page.waitForFunction(
      () => document.querySelector('#jobs-list')?.textContent === 'Nothing recorded yet.',
    );
    expect(await page.locator('#jobs-list button[data-job-id]').count()).toBe(0);
  });
});
