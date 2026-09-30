import { AsyncLocalStorage } from 'node:async_hooks';

/** Identity and attribution carried across one request or background job. */
export interface ExecutionContext {
  actor: string;
  origin: string;
  jobId: string;
  workspace: string;
}

const EMPTY_CONTEXT: Readonly<ExecutionContext> = Object.freeze({
  actor: '',
  origin: '',
  jobId: '',
  workspace: '',
});

const STORAGE = new AsyncLocalStorage<ExecutionContext>();

export function currentContext(): Readonly<ExecutionContext> {
  return STORAGE.getStore() ?? EMPTY_CONTEXT;
}

export function runWithContext<T>(values: Partial<ExecutionContext>, fn: () => T): T {
  return STORAGE.run({ ...currentContext(), ...values }, fn);
}
