/** Strict seed-specific REST decoding and complete pagination. */
import { ConflictError, CreateFailedError } from '../lib/errors';
import { sleep as interruptibleSleep } from '../seams/exec';
import { rcapi, type Auth, type MultipartPart } from '../core/rcapi';

export type Bag = Record<string, unknown>;
export type Headers = Record<string, string>;
export type ParticipantLogin = (
  root: string,
  credentials: { user: string; password: string },
) => Promise<Auth>;
export const map = (value: unknown): Bag =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Bag) : {};
export const list = (value: unknown): Bag[] => (Array.isArray(value) ? value.map(map) : []);
export const id = (value: unknown): string => (typeof value === 'string' ? value : '');

const RATE_LIMITED = 'error-too-many-requests';
const RETRYABLE_WRITES = new Set(['/api/v1/chat.sendMessage', '/api/v1/chat.react']);
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RATE_LIMIT_WAIT_MS = 120_000;

interface Options {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

/** Rocket.Chat's explicit limiter refusal carries the delay before another request. */
function rateLimitDelay(text: string, headers: Headers, now: number): number | null {
  const body = map(JSON.parse(text));
  if (body.success !== false) return null;
  const hints: number[] = [];
  const responseTime = Date.parse(headers.date ?? '');
  const reference = Number.isFinite(responseTime) ? responseTime : now;
  const after = headers['retry-after'];
  if (after !== undefined) {
    const delay = /^\d+(?:\.\d+)?$/u.test(after)
      ? Number(after) * 1000
      : Date.parse(after) - reference;
    if (Number.isFinite(delay) && delay >= 0) hints.push(delay);
  }
  const reset = headers['x-ratelimit-reset'];
  // Rocket.Chat's reset is an epoch in milliseconds, not a relative number of seconds.
  if (reset !== undefined && /^\d+$/u.test(reset)) {
    const delay = Number(reset) - reference;
    if (Number.isFinite(delay)) hints.push(Math.max(0, delay));
  }
  const seconds = /\bwait (\d+(?:\.\d+)?) seconds?\b/iu.exec(id(body.error));
  if (seconds !== null) hints.push(Number(seconds[1]) * 1000);
  // Use every valid server hint; never shorten a longer Retry-After to a local cap.
  return hints.length === 0 ? null : Math.ceil(Math.max(...hints)) + 250;
}

export class ApiRejected extends CreateFailedError {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly errorType: string,
  ) {
    super(
      `seed request ${path} was refused (HTTP ${status}${errorType === '' ? '' : `, ${errorType}`})`,
    );
  }
}

export class Client {
  private rateLimitWaitMs = 0;
  constructor(
    readonly root: string,
    private readonly options: Options = {},
  ) {}
  decode(path: string, status: number, text: string): Bag {
    let body: Bag;
    try {
      body = map(JSON.parse(text));
    } catch {
      throw new ConflictError(
        `seed request ${path} returned invalid JSON; its result is uncertain`,
      );
    }
    if (status >= 400 || body.success === false) {
      const legacy =
        body.error === "You can't send messages because the room is readonly."
          ? 'error-room-read-only'
          : body.error === 'You_have_been_muted'
            ? 'error-user-muted'
            : '';
      const errorType =
        id(body.errorType) ||
        (id(body.error).endsWith(`[${RATE_LIMITED}]`) ? RATE_LIMITED : legacy);
      throw new ApiRejected(status, path, errorType);
    }
    if (Object.keys(body).length === 0)
      throw new ConflictError(
        `seed request ${path} returned an empty response; its result is uncertain`,
      );
    return body;
  }
  async request(
    method: string,
    path: string,
    headers: Headers,
    data?: Bag,
    params?: Record<string, string | number | boolean>,
  ): Promise<Bag> {
    // Personal stars are read as their owner after seed restores the API limiter.
    // Other reads remain outside this bounded, explicit-refusal retry policy.
    const retryable =
      (method === 'POST' && RETRYABLE_WRITES.has(path)) ||
      (method === 'GET' && path === '/api/v1/chat.getMessage');
    for (let retries = 0; ; retries += 1) {
      const responseHeaders: Headers = {};
      const [status, text] = await rcapi.call(this.root, method, path, {
        extraHeaders: headers,
        responseHeaders,
        ...(data === undefined ? {} : { data }),
        ...(params === undefined ? {} : { params }),
      });
      try {
        return this.decode(path, status, text);
      } catch (error) {
        if (
          !(error instanceof ApiRejected) ||
          error.status !== 429 ||
          error.errorType !== RATE_LIMITED ||
          !retryable ||
          retries >= MAX_RATE_LIMIT_RETRIES
        )
          throw error;
        const delay = rateLimitDelay(text, responseHeaders, (this.options.now ?? Date.now)());
        if (delay === null || this.rateLimitWaitMs + delay > MAX_RATE_LIMIT_WAIT_MS) throw error;
        this.rateLimitWaitMs += delay;
        this.options.log?.(
          `  ${path} was rate-limited; waiting ${(delay / 1000).toFixed(2)} seconds before retrying the refused request`,
        );
        // Cancellation propagates without another attempt; transport errors and uploads
        // never reach this retry path. Every attempt keeps the original actor and inputs.
        await (this.options.sleep ?? interruptibleSleep)(delay);
      }
    }
  }
  async get(
    path: string,
    headers: Headers,
    params?: Record<string, string | number | boolean>,
  ): Promise<Bag> {
    return await this.request('GET', path, headers, undefined, params);
  }
  async post(path: string, headers: Headers, data: Bag): Promise<Bag> {
    return await this.request('POST', path, headers, data);
  }
  async room(rid: string, headers: Headers): Promise<Bag> {
    const body = await this.get('/api/v1/rooms.adminRooms.getRoom', headers, { rid });
    return map(body.room ?? body);
  }
  async pendingMessage(
    mid: string,
    rid: string,
    api: string,
    headers: Headers,
  ): Promise<Bag | null> {
    try {
      const found = map(
        (await this.get('/api/v1/chat.getMessage', headers, { msgId: mid })).message,
      );
      if (id(found._id) === '')
        throw new CreateFailedError('message readback returned no identity');
      return found;
    } catch (error) {
      if (!(error instanceof ApiRejected) || ![400, 404].includes(error.status)) throw error;
      if (
        ['error-invalid-message', 'error-message-not-found', 'error-invalid-message-id'].includes(
          error.errorType,
        )
      )
        return null;
      if (error.errorType !== '') throw error;
      // Older servers give an empty 400 for an absent message. A complete, authorized
      // room read distinguishes absence from a refused message lookup.
      return (
        (await this.pages(`/api/v1/${api}.messages`, headers, 'messages', { roomId: rid })).find(
          (m) => m._id === mid,
        ) ?? null
      );
    }
  }
  async multipart(path: string, headers: Headers, parts: readonly MultipartPart[]): Promise<Bag> {
    const [status, text] = await rcapi.multipart(this.root, path, headers, parts);
    return this.decode(path, status, text);
  }
  async pages(
    path: string,
    headers: Headers,
    key: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<Bag[]> {
    const out: Bag[] = [];
    for (let offset = 0; ; offset += 100) {
      const body = await this.get(path, headers, { ...params, count: 100, offset });
      if (!Array.isArray(body[key]))
        throw new CreateFailedError(`seed readback ${path} is missing ${key}`);
      const page = list(body[key]);
      out.push(...page);
      if (typeof body.total === 'number') {
        if (out.length >= body.total) return out;
        if (page.length === 0)
          throw new CreateFailedError(`seed readback ${path} ended before its total`);
      } else if (page.length < 100) return out;
      if (offset >= 1_000_000)
        throw new CreateFailedError(`seed readback ${path} exceeded its pagination limit`);
    }
  }
}
