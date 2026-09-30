/** Shared mechanics for route modules, below them in the dependency graph. */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import * as config from '../lib/config';
import { formatFixed, isTruthy, storedText } from '../lib/format';
import type * as KubeNamesNS from '../core/kube/names';
import type { JobKind, JobTarget, SubmitOptions } from './jobs';

export type Bag = Record<string, unknown>;

const FORM_BODY = Symbol('houston form body');

export interface RequestValidationIssue {
  type: string;
  loc: readonly (string | number)[];
  msg: string;
  input: unknown;
  ctx?: Readonly<Record<string, unknown>>;
}

/** The transport-level 422 for a request that fails validation, not a service error. */
export class RequestValidationError extends Error {
  readonly statusCode = 422;

  constructor(readonly detail: readonly RequestValidationIssue[]) {
    super('request validation failed');
    this.name = 'RequestValidationError';
  }
}

export function bag(value: unknown): Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Bag) }
    : {};
}

export function requestBody(value: unknown, required: boolean): Bag {
  if (value === undefined || value === null) {
    if (!required) return {};
    throw new RequestValidationError([
      { type: 'missing', loc: ['body'], msg: 'Field required', input: null },
    ]);
  }
  if (typeof value === 'object' && !Array.isArray(value) && FORM_BODY in (value as object)) {
    const source = (value as { [FORM_BODY]: string })[FORM_BODY];
    if (source === '') {
      if (!required) return {};
      throw new RequestValidationError([
        { type: 'missing', loc: ['body'], msg: 'Field required', input: null },
      ]);
    }
    throw new RequestValidationError([
      {
        type: 'dict_type',
        loc: ['body'],
        msg: 'Input should be a valid object',
        input: source,
      },
    ]);
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Bag) };
  }
  throw new RequestValidationError([
    {
      type: 'dict_type',
      loc: ['body'],
      msg: 'Input should be a valid object',
      input: value,
    },
  ]);
}

/** Mark @fastify/formbody output without changing its enumerable handler value. */
export function markFormBody(value: Bag, source: string): Bag {
  Object.defineProperty(value, FORM_BODY, { value: source });
  return value;
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(storedText) : [];
}

export function actor(request: FastifyRequest): string {
  return request.houstonActor || '';
}

export function submit<Result>(
  app: FastifyInstance,
  kind: JobKind,
  target: JobTarget<Result>,
  options: SubmitOptions = {},
): { job_id: string } {
  return { job_id: app.jobs.submit(kind, target, options).id };
}

export function bool(value: unknown, fallback = false): boolean {
  return value === undefined ? fallback : isTruthy(value);
}

/** The established bool query coercion, without treating the string "false" as truthy. */
export function queryBool(value: unknown, fallback = false, name = 'boolean'): boolean {
  value = queryScalar(value);
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  if (value === 0) return false;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  throw new RequestValidationError([
    {
      type: 'bool_parsing',
      loc: ['query', name],
      msg: 'Input should be a valid boolean, unable to interpret input',
      input: value,
    },
  ]);
}

export function queryInt(value: unknown, fallback: number, name: string): number {
  value = queryScalar(value);
  if (value === undefined) return fallback;
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (typeof normalized === 'number' && Number.isInteger(normalized)) return normalized;
  if (typeof normalized === 'string' && /^[+-]?\d+(?:\.0+)?$/u.test(normalized)) {
    const integral = normalized.replace(/\.0+$/u, '');
    const parsed = BigInt(integral);
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    if (parsed < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
    return Number(parsed);
  }
  throw new RequestValidationError([
    {
      type: 'int_parsing',
      loc: ['query', name],
      msg: 'Input should be a valid integer, unable to parse string as an integer',
      input: value,
    },
  ]);
}

function queryScalar(value: unknown): unknown {
  return Array.isArray(value) ? value.at(-1) : value;
}

export function queryText(
  value: unknown,
  fallback: string,
  name: string,
  required = false,
): string {
  const scalar = queryScalar(value);
  if (scalar !== undefined) return String(scalar);
  if (!required) return fallback;
  throw new RequestValidationError([
    { type: 'missing', loc: ['query', name], msg: 'Field required', input: null },
  ]);
}

export function text(value: unknown, fallback = ''): string {
  return value === undefined ? fallback : storedText(value);
}

/** `value` as text when `isTruthy` holds it true, else `fallback`, for untyped JSON fields. */
export function orText(value: unknown, fallback = ''): string {
  return isTruthy(value) ? storedText(value) : fallback;
}

export function kubeContext(value: unknown): string {
  const configured = bag(value)[config.EXTRA_CONTEXT];
  if (isTruthy(configured)) return storedText(configured);
  const names = require('../core/kube/names') as typeof KubeNamesNS;
  return names.CONTEXT;
}

export function oneDecimal(value: number): number {
  return Number(formatFixed(value, 1));
}

export function number(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
