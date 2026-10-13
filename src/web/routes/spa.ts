/** The frozen single-page application, registered last. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const WEBUI = path.resolve(__dirname, '../../../data/webui');

function contentType(filename: string): string {
  if (filename.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filename.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filename.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

interface ByteRange {
  start: number;
  end: number;
}

type RangeResult = { ranges: ByteRange[] } | { status: 400; content: string } | { status: 416 };

function byteRanges(header: string, size: number): RangeResult {
  const separator = header.indexOf('=');
  if (separator === -1) return { status: 400, content: 'Malformed range header.' };
  if (header.slice(0, separator).trim().toLowerCase() !== 'bytes') {
    return { status: 400, content: 'Only support bytes range' };
  }
  const parts = header.slice(separator + 1).split(',');
  if (parts.length > 100) return { ranges: [] };
  const found: ByteRange[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (part === '' || part === '-' || !part.includes('-')) continue;
    const dash = part.indexOf('-');
    const rawStart = part.slice(0, dash).trim();
    const rawEnd = part.slice(dash + 1).trim();
    if (!/^(?:[+-]?\d+)?$/u.test(rawStart) || !/^(?:[+-]?\d+)?$/u.test(rawEnd)) continue;
    const start = rawStart === '' ? Math.max(size - Number(rawEnd), 0) : Number(rawStart);
    const end =
      rawStart !== '' && rawEnd !== '' && Number(rawEnd) < size ? Number(rawEnd) + 1 : size;
    found.push({ start, end });
  }
  if (found.length === 0) {
    return { status: 400, content: 'Range header: range must be requested' };
  }
  if (found.some(({ start }) => !(start >= 0 && start < size))) return { status: 416 };
  if (found.some(({ start, end }) => start >= end)) {
    return { status: 400, content: 'Range header: start must be less than end' };
  }
  found.sort((left, right) => left.start - right.start);
  const merged: ByteRange[] = [];
  for (const item of found) {
    const prior = merged.at(-1);
    if (prior !== undefined && item.start <= prior.end) prior.end = Math.max(prior.end, item.end);
    else merged.push({ ...item });
  }
  return { ranges: merged };
}

function sendSpa(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const encoded = request.url.split('?', 1)[0] ?? '/';
  let requested: string;
  try {
    requested = decodeURIComponent(encoded);
  } catch {
    return reply.code(404).send({ detail: 'Not Found' });
  }
  const relative = requested.replace(/^\/+/, '');
  let candidate = path.resolve(WEBUI, relative);
  const inside = candidate === WEBUI || candidate.startsWith(`${WEBUI}${path.sep}`);
  if (!inside || candidate.includes('\0') || !fs.existsSync(candidate)) {
    return reply.code(404).send({ detail: 'Not Found' });
  }
  let stat = fs.statSync(candidate);
  if (stat.isDirectory()) {
    candidate = path.join(candidate, 'index.html');
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      return reply.code(404).send({ detail: 'Not Found' });
    }
    if (!requested.endsWith('/')) return reply.redirect(`${encoded}/`, 307);
    stat = fs.statSync(candidate);
  }
  if (!stat.isFile()) return reply.code(404).send({ detail: 'Not Found' });
  // The page itself is never stored. Back after signing out showed a cached shell whose
  // modules were then sent to sign-in, so nothing ran; unstored, Back asks the server, and a
  // signed-out browser is redirected to sign-in. The modules keep `no-cache` and their ETag.
  if (contentType(candidate).startsWith('text/html')) reply.header('Cache-Control', 'no-store');
  const etagBase = `${String(stat.mtimeMs / 1000)}-${String(stat.size)}`;
  const etag = `"${createHash('md5').update(etagBase).digest('hex')}"`;
  const lastModified = stat.mtime.toUTCString();
  if (
    request.headers['if-none-match']
      ?.split(',')
      .some((tag) => tag.trim().replace(/^W\//u, '') === etag) === true ||
    (request.headers['if-none-match'] === undefined &&
      request.headers['if-modified-since'] !== undefined &&
      new Date(request.headers['if-modified-since']).getTime() >=
        Math.floor(stat.mtime.getTime() / 1000) * 1000)
  ) {
    return reply.code(304).header('etag', etag).send();
  }
  const mediaType = contentType(candidate);
  const rangeHeader = request.headers.range;
  const ifRange = request.headers['if-range'];
  let requestedRanges: ByteRange[] | undefined;
  if (
    rangeHeader !== undefined &&
    (ifRange === undefined || ifRange === etag || ifRange === lastModified)
  ) {
    const parsed = byteRanges(rangeHeader, stat.size);
    if ('status' in parsed) {
      if (parsed.status === 400) {
        return reply.code(400).type('text/plain; charset=utf-8').send(parsed.content);
      }
      return reply
        .code(416)
        .type('text/plain; charset=utf-8')
        .header('content-range', `bytes */${String(stat.size)}`)
        .send('');
    }
    requestedRanges = parsed.ranges;
  }
  const base = reply
    .type(mediaType)
    .header('accept-ranges', 'bytes')
    .header('last-modified', lastModified)
    .header('etag', etag);
  if (requestedRanges !== undefined) {
    if (requestedRanges.length === 1) {
      const { start, end } = requestedRanges[0] as ByteRange;
      return base
        .code(206)
        .header('content-range', `bytes ${String(start)}-${String(end - 1)}/${String(stat.size)}`)
        .header('content-length', String(end - start))
        .send(fs.readFileSync(candidate).subarray(start, end));
    }
    if (requestedRanges.length > 1) {
      const boundary = randomBytes(13).toString('hex');
      const document = fs.readFileSync(candidate);
      const parts: Buffer[] = [];
      for (const { start, end } of requestedRanges) {
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Type: ${mediaType}\r\n` +
              `Content-Range: bytes ${String(start)}-${String(end - 1)}/${String(stat.size)}\r\n\r\n`,
            'latin1',
          ),
          document.subarray(start, end),
          Buffer.from('\r\n'),
        );
      }
      parts.push(Buffer.from(`--${boundary}--`, 'latin1'));
      const body = Buffer.concat(parts);
      return base
        .code(206)
        .type(`multipart/byteranges; boundary=${boundary}`)
        .header('content-length', String(body.length))
        .send(body);
    }
  }
  return base
    .type(contentType(candidate))
    .header('content-length', String(stat.size))
    .send(fs.readFileSync(candidate));
}

export function register(app: FastifyInstance): void {
  app.head('/', { config: { houstonSpa: true } }, sendSpa);
  app.head('/*', { config: { houstonSpa: true } }, sendSpa);
  app.get('/', { config: { houstonSpa: true } }, sendSpa);
  app.get('/*', { config: { houstonSpa: true } }, sendSpa);
}
