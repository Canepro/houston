/**
 * Moving bytes in and out of a pod.
 *
 * `backup.ts` needs exactly five things from a runtime and its logic -- the bundle format,
 * the manifest, the safety checks -- is runtime-agnostic, so these mirror the Compose
 * `composeExec*` signatures rather than inventing a shape.
 */
import * as fs from 'node:fs';

import { capture, stream } from '../../seams/exec';

import { envFor } from './exec';
import { kube } from './exec';
import { APPLY_TIMEOUT, INSTALL_TIMEOUT, MONGO_SERVICE, isOurs } from './names';
import { namespaceFor } from './namespace';

/**
 * Run a command in the MongoDB pod, capturing stdout. Mirrors `composeExecCapture`,
 * including its `[1, '']` on failure.
 */
export async function execCapture(
  name: string,
  argv: readonly string[],
  { context, timeout }: { context: string; timeout?: number },
): Promise<[number, string]> {
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      await namespaceFor(name),
      'exec',
      `${MONGO_SERVICE}-0`,
      '-c',
      'mongod',
      '--',
      ...argv,
    ],
    { timeout: timeout ?? APPLY_TIMEOUT, own: isOurs(context) },
  );
  return [res.returncode, res.stdout];
}

/**
 * Run a command in the MongoDB pod, writing its RAW stdout to `destination`.
 *
 * Binary-safe, and that is the whole point: `mongodump --archive` emits BSON, and a
 * text-mode decode would corrupt it silently -- the dump would restore with errors nobody
 * could trace back here.
 *
 * `kubectl exec` without `-t`, deliberately: a TTY translates newlines and would do the
 * same damage from the other end.
 *
 * This is the one place in the package that reaches the process seam rather than
 * `kube.run`: the funnel captures stdout into a string by contract, and a string is
 * exactly what must not happen to an archive.
 */
export async function execToFile(
  name: string,
  argv: readonly string[],
  destination: string,
  { context, timeout }: { context: string; timeout?: number },
): Promise<[number, string]> {
  const full: [string, ...string[]] = [
    'kubectl',
    '--context',
    context,
    '-n',
    await namespaceFor(name),
    'exec',
    `${MONGO_SERVICE}-0`,
    '-c',
    'mongod',
    '--',
    ...argv,
  ];
  const sink = fs.createWriteStream(destination);
  const env = envFor(context);
  try {
    const errors: Buffer[] = [];
    const result = await stream(full, {
      encoding: null,
      stdoutSink: sink,
      timeoutMs: (timeout ?? INSTALL_TIMEOUT) * 1000,
      ...(env !== undefined ? { env } : {}),
      onStderr: (chunk) => {
        errors.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      },
    });
    return [result.exitCode ?? 1, Buffer.concat(errors).toString('utf8')];
  } catch (error) {
    return [1, String(error)];
  } finally {
    await new Promise<void>((resolve) => sink.end(resolve));
  }
}

/**
 * Run a command in the MongoDB pod with `source` piped to its stdin.
 *
 * `-i` is required and easy to forget: without it kubectl closes stdin immediately and
 * `mongorestore --archive` reads an empty archive, reports success, and restores nothing
 * at all.
 */
export async function execFromFile(
  name: string,
  argv: readonly string[],
  source: string,
  { context, timeout }: { context: string; timeout?: number },
): Promise<[number, string]> {
  const full: [string, ...string[]] = [
    'kubectl',
    '--context',
    context,
    '-n',
    await namespaceFor(name),
    'exec',
    '-i',
    `${MONGO_SERVICE}-0`,
    '-c',
    'mongod',
    '--',
    ...argv,
  ];
  const env = envFor(context);
  try {
    const result = await capture(full, {
      encoding: null,
      mergeStderr: true,
      stdin: fs.createReadStream(source),
      timeoutMs: (timeout ?? INSTALL_TIMEOUT) * 1000,
      ...(env !== undefined ? { env } : {}),
    });
    const out = result.stdout;
    return [
      result.exitCode ?? 1,
      out === null ? '' : typeof out === 'string' ? out : out.toString('utf8'),
    ];
  } catch (error) {
    return [1, String(error)];
  }
}
