/** Seed, bulk scale, and pinned multipart settings imports. */

import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import * as data from '../../core/data';
import { resolveName } from '../../core/lifecycle/naming';
import { runSeedInline } from '../../core/lifecycle/seeding';
import { workspace } from '../../core/runner/paths';
import { readMeta } from '../../core/runner/record';
import { ValidationError } from '../../lib/errors';
import { joinPath } from '../../lib/home';
import { stripText } from '../../lib/format';
import { bool, orText, RequestValidationError, requestBody, submit, text } from '../route-deps';

export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
export const UPLOAD_ID = /^u[0-9a-f]{12}$/u;

function onlySet(raw: string): ReadonlySet<string> | null {
  const values = raw
    .split(',')
    .map((value) => stripText(value))
    .filter((value) => value !== '');
  return values.length === 0 ? null : new Set(values);
}

function pruneUploads(directory: string, keep = 5): void {
  const uploads = fs
    .readdirSync(directory)
    .filter((entry) => /^u[0-9a-f]{12}\.json$/u.test(entry))
    .map((entry) => ({ entry, mtime: fs.statSync(joinPath(directory, entry)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  for (const { entry } of uploads.slice(keep)) {
    fs.rmSync(joinPath(directory, entry), { force: true });
    fs.rmSync(joinPath(directory, entry.replace(/\.json$/u, '.only')), { force: true });
  }
}

async function readUpload(request: FastifyRequest): Promise<[Buffer, string, boolean]> {
  if (!request.isMultipart()) {
    throw new RequestValidationError([
      { type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null },
    ]);
  }
  let contents = Buffer.alloc(0);
  let oversized = false;
  let only = '';
  let found = false;
  for await (const part of request.parts({
    limits: { fileSize: MAX_UPLOAD_BYTES + 1 },
  })) {
    if (part.type === 'file') {
      if (part.fieldname !== 'file') {
        part.file.resume();
        continue;
      }
      found = true;
      const chunks: Buffer[] = [];
      let size = 0;
      let thisOversized = false;
      for await (const chunk of part.file) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > MAX_UPLOAD_BYTES) {
          thisOversized = true;
        } else {
          chunks.push(bytes);
        }
      }
      contents = Buffer.concat(chunks, Math.min(size, MAX_UPLOAD_BYTES));
      oversized = thisOversized || part.file.truncated;
    } else if (part.fieldname === 'only') {
      only = text(part.value);
    }
  }
  if (!found) {
    throw new RequestValidationError([
      { type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null },
    ]);
  }
  return [contents, only, oversized];
}

async function importThenDelete(
  target: string,
  uploadPath: string,
  selected: ReadonlySet<string> | null,
  emit: Parameters<typeof data.importApply>[3],
): Promise<Record<string, unknown>> {
  try {
    return await data.importApply(target, uploadPath, selected, emit);
  } finally {
    fs.rmSync(uploadPath, { force: true });
    fs.rmSync(uploadPath.replace(/\.json$/u, '.only'), { force: true });
  }
}

export function register(app: FastifyInstance): void {
  app.post<{ Params: { name: string } }>('/api/repros/:name/seed', async (request) => {
    const body = requestBody(request.body, false);
    const meta = await readMeta(await resolveName(request.params.name));
    const profile = Object.hasOwn(body, 'profile') ? body.profile : 'small';
    return submit(
      app,
      'seed',
      (emit) => runSeedInline(meta, profile as string, bool(body.stats), emit),
      { label: meta.name },
    );
  });

  app.post<{ Params: { name: string } }>('/api/repros/:name/scale', async (request) => {
    const body = requestBody(request.body, true);
    const scale = Object.hasOwn(body, 'scale') ? body.scale : '';
    const target = await resolveName(request.params.name);
    return submit(app, 'scale', (emit) => data.runScale(target, scale as string, emit), {
      label: target,
    });
  });

  app.delete<{ Params: { name: string } }>('/api/repros/:name/scale', async (request) => {
    const target = await resolveName(request.params.name);
    return submit(app, 'clear-scale', (emit) => data.clearScale(target, emit), { label: target });
  });

  app.post<{ Params: { name: string } }>(
    '/api/repros/:name/config-import/plan',
    async (request) => {
      const [contents, only, oversized] = await readUpload(request);
      const target = await resolveName(request.params.name);
      if (oversized) throw new ValidationError('settings file is larger than 16 MB');
      const directory = joinPath(workspace(target), 'import');
      fs.mkdirSync(directory, { recursive: true });
      const uploadId = `u${randomBytes(6).toString('hex')}`;
      const uploadPath = joinPath(directory, `${uploadId}.json`);
      fs.writeFileSync(uploadPath, contents);
      fs.writeFileSync(joinPath(directory, `${uploadId}.only`), only, 'utf8');
      pruneUploads(directory);
      const plan = await data.importPlan(target, uploadPath, onlySet(only));
      return { ...plan, upload_id: uploadId };
    },
  );

  app.post<{ Params: { name: string } }>(
    '/api/repros/:name/config-import',
    async (request, reply) => {
      const body = requestBody(request.body, false);
      const target = await resolveName(request.params.name);
      const uploadId = orText(body.upload_id);
      if (!UPLOAD_ID.test(uploadId)) {
        return reply.code(400).send({
          error: 'missing or malformed upload_id - preview the plan first',
          kind: 'ValidationError',
        });
      }
      const uploadPath = joinPath(workspace(target), 'import', `${uploadId}.json`);
      if (!fs.existsSync(uploadPath)) {
        return reply.code(400).send({
          error: 'no uploaded settings.json - preview the plan first',
          kind: 'ValidationError',
        });
      }
      const onlyPath = uploadPath.replace(/\.json$/u, '.only');
      const selected = onlySet(fs.existsSync(onlyPath) ? fs.readFileSync(onlyPath, 'utf8') : '');
      return submit(
        app,
        'config-import',
        (emit) => importThenDelete(target, uploadPath, selected, emit),
        { label: target },
      );
    },
  );
}
