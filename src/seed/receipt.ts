/** Durable, token-free write-ahead receipts. Callers hold the workspace lock. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { ConflictError, CreateFailedError } from '../lib/errors';
import { workspace } from '../core/runner/paths';
import { joinPath } from '../lib/home';
import type { Plan } from './plan';

type Bag = Record<string, unknown>;
type RecordLine = {
  key: string;
  state: 'intent' | 'done' | 'rejected';
  data: Bag;
  previous: string;
  hash: string;
};
export interface Manifest {
  version: number;
  run: string;
  reference: string;
  target: string;
  plan: Plan;
  planHash: string;
  generation: number;
}
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class ReceiptStorageError extends CreateFailedError {
  constructor() {
    super('seed receipt could not be durably stored; refusing further mutations');
  }
}

export function pendingReceipt(name: string): Manifest | null {
  const directory = joinPath(workspace(name), 'seed-receipts');
  const pointer = joinPath(directory, 'active.json');
  if (!fs.existsSync(pointer)) return null;
  try {
    regular(pointer);
    const active = JSON.parse(fs.readFileSync(pointer, 'utf8')) as { run: string };
    if (!/^[0-9a-f-]{36}$/u.test(active.run))
      throw new ConflictError('invalid pending seed receipt');
    const file = joinPath(directory, `${active.run}.json`);
    regular(file);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
    if (
      manifest.version !== 1 ||
      manifest.run !== active.run ||
      !Number.isFinite(Date.parse(manifest.reference)) ||
      typeof manifest.target !== 'string' ||
      !Number.isSafeInteger(manifest.generation) ||
      manifest.generation < 0 ||
      manifest.planHash !== hash(manifest.plan)
    )
      throw new ConflictError('invalid pending seed manifest');
    const records = readRecords(joinPath(directory, `${active.run}.wal`), false);
    return records.some((line) => line.key === 'phase:complete' && line.state === 'done')
      ? null
      : manifest;
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    throw new CreateFailedError('pending seed receipt could not be read');
  }
}

function regular(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ConflictError('seed receipt is not a regular file');
}

function readRecords(file: string, recoverTail = true): RecordLine[] {
  regular(file);
  const bytes = fs.readFileSync(file, 'utf8');
  const boundary = bytes.lastIndexOf('\n') + 1;
  const out: RecordLine[] = [];
  let previous = '';
  for (const text of bytes
    .slice(0, boundary)
    .split('\n')
    .filter((line) => line !== '')) {
    const raw: unknown = JSON.parse(text);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new ConflictError('seed receipt record is invalid');
    const fields = raw as Bag;
    const { hash: stored, ...payload } = fields;
    if (
      typeof fields.key !== 'string' ||
      typeof fields.state !== 'string' ||
      !['intent', 'done', 'rejected'].includes(fields.state) ||
      fields.data === null ||
      typeof fields.data !== 'object' ||
      Array.isArray(fields.data) ||
      fields.previous !== previous ||
      hash(payload) !== stored
    )
      throw new ConflictError('seed receipt is corrupt; refusing to repeat uncertain writes');
    const record = raw as RecordLine;
    safe(record.data);
    previous = record.hash;
    out.push(record);
  }
  // An incomplete trailing result retains its durable intent for reconciliation.
  if (recoverTail && boundary < bytes.length) {
    fs.truncateSync(file, Buffer.byteLength(bytes.slice(0, boundary)));
    const fd = fs.openSync(file, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  return out;
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function durableFile(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  syncDirectory(path.dirname(file));
}

function safe(value: unknown): void {
  if (Array.isArray(value)) {
    for (const v of value) safe(v);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (/token|password|secret|authorization|mongo.?url/iu.test(key))
        throw new CreateFailedError('credentials cannot be persisted in a seed receipt');
      safe(v);
    }
  }
}

export class Receipt {
  readonly manifest: Manifest;
  readonly owned = new Map<string, Bag>();
  readonly entries = new Map<string, RecordLine>();
  readonly persistent: boolean;
  private tail = '';
  private file = '';
  private pointer = '';
  private broken = false;

  constructor(plan: Plan, target = 'memory', name = '') {
    this.persistent = name !== '';
    let manifest: Manifest = {
      version: 1,
      run: randomUUID(),
      reference: new Date().toISOString(),
      target,
      plan,
      planHash: hash(plan),
      generation: 0,
    };
    try {
      if (this.persistent) {
        const directory = joinPath(workspace(name), 'seed-receipts');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        syncDirectory(path.dirname(directory));
        this.pointer = joinPath(directory, 'active.json');
        const names = fs
          .readdirSync(directory)
          .filter((n) => /^[0-9a-f-]{36}\.json$/u.test(n))
          .sort();
        const manifests = names
          .map((filename) => {
            regular(joinPath(directory, filename));
            const prior = JSON.parse(
              fs.readFileSync(joinPath(directory, filename), 'utf8'),
            ) as Manifest;
            if (
              prior.version !== 1 ||
              !/^[0-9a-f-]{36}$/u.test(prior.run) ||
              filename !== `${prior.run}.json` ||
              !Number.isFinite(Date.parse(prior.reference)) ||
              typeof prior.target !== 'string' ||
              !Number.isSafeInteger(prior.generation) ||
              prior.generation < 0 ||
              prior.planHash !== hash(prior.plan)
            )
              throw new ConflictError(
                'invalid seed manifest; refusing to use its paths or repeat writes',
              );
            return prior;
          })
          .sort((a, b) => a.generation - b.generation);
        manifest.generation = (manifests.at(-1)?.generation ?? -1) + 1;
        for (const prior of manifests) {
          if (prior.target !== target) continue;
          for (const line of readRecords(joinPath(directory, `${prior.run}.wal`))) {
            if (line.state === 'done' && /^(user|room|emoji):/u.test(line.key))
              this.owned.set(line.key, line.data);
          }
        }
        if (fs.existsSync(this.pointer)) {
          regular(this.pointer);
          const active = JSON.parse(fs.readFileSync(this.pointer, 'utf8')) as { run: string };
          if (!/^[0-9a-f-]{36}$/u.test(active.run))
            throw new ConflictError('invalid active seed receipt');
          const prior = manifests.find((m) => m.run === active.run);
          if (prior === undefined) throw new ConflictError('active seed manifest is missing');
          const records = readRecords(joinPath(directory, `${prior.run}.wal`));
          if (records.some((r) => r.key === 'phase:complete' && r.state === 'done')) {
            fs.unlinkSync(this.pointer);
            syncDirectory(directory);
          } else {
            manifest = prior;
            if (manifest.target !== target || manifest.planHash !== hash(plan)) {
              throw new ConflictError(
                'an unfinished seed has different options or a different database target; resume it with its original options',
              );
            }
            this.file = joinPath(directory, `${manifest.run}.wal`);
            for (const line of records) {
              this.entries.set(line.key, line);
              this.tail = line.hash;
            }
          }
        }
        if (this.file === '') {
          this.file = joinPath(directory, `${manifest.run}.wal`);
          const fd = fs.openSync(this.file, 'wx', 0o600);
          try {
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          syncDirectory(directory);
          durableFile(joinPath(directory, `${manifest.run}.json`), manifest);
          durableFile(this.pointer, { run: manifest.run });
        }
      }
    } catch (error) {
      if (error instanceof ConflictError || error instanceof CreateFailedError) throw error;
      throw new CreateFailedError(
        'seed receipts could not be read or durably stored; refusing API mutations',
      );
    }
    this.manifest = manifest;
  }

  record(key: string, state: RecordLine['state'], data: Bag): void {
    if (this.broken) throw new ReceiptStorageError();
    safe(data);
    const payload = { key, state, data, previous: this.tail };
    const record = { ...payload, hash: hash(payload) };
    if (this.persistent) {
      try {
        const fd = fs.openSync(this.file, 'a', 0o600);
        try {
          fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        this.broken = true;
        throw new ReceiptStorageError();
      }
    }
    this.entries.set(key, record);
    this.tail = record.hash;
    if (state === 'done' && /^(user|room|emoji):/u.test(key)) this.owned.set(key, data);
  }

  done(key: string): Bag | null {
    const entry = this.entries.get(key);
    return entry?.state === 'done' ? entry.data : null;
  }
  intent(key: string): Bag | null {
    const entry = this.entries.get(key);
    return entry?.state === 'intent' ? entry.data : null;
  }
  identifier(key: string): string {
    return `hs${createHash('sha256').update(`${this.manifest.run}:${key}`).digest('hex').slice(0, 22)}`;
  }

  async step(
    key: string,
    data: Bag,
    perform: () => Promise<Bag>,
    reconcile?: (intent: Bag) => Promise<Bag | null>,
  ): Promise<Bag> {
    if (this.broken) throw new ReceiptStorageError();
    const done = this.done(key);
    if (done !== null) return done;
    const pending = this.intent(key);
    if (pending !== null) {
      if (reconcile === undefined)
        throw new ConflictError(
          `seed operation ${key} has an uncertain result; refusing to repeat it`,
        );
      const recovered = await reconcile(pending);
      if (recovered !== null) {
        this.record(key, 'done', recovered);
        return recovered;
      }
    }
    this.record(key, 'intent', data);
    const result = await perform();
    this.record(key, 'done', result);
    return result;
  }

  finish(): void {
    this.record('phase:complete', 'done', {});
    if (this.persistent) {
      try {
        fs.unlinkSync(this.pointer);
        syncDirectory(path.dirname(this.pointer));
      } catch {
        throw new CreateFailedError('completed seed receipt could not be durably retired');
      }
    }
  }
}
