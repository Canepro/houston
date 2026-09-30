import { NotReadyError } from '../../src/lib/errors';

import { runCli, type CommandExecutor } from '../../src/cli/app';
import { parseJsonTranscript } from '../../src/cli/wire';

async function capture(argv: string[], execute: CommandExecutor) {
  let stdout = '';
  let stderr = '';
  const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  try {
    const code = await runCli(argv, {
      execute,
      io: {
        writeOut: (value) => {
          stdout += value;
        },
        writeErr: (value) => {
          stderr += value;
        },
      },
    });
    return { code, stdout, stderr };
  } finally {
    write.mockRestore();
  }
}

describe('the process JSON contract', () => {
  test('the envelope boundary preserves the float and exponent spelling of earlier releases', async () => {
    const payload = {
      dump_seconds: 1,
      restore_seconds: 30,
      nested: { boot_seconds: 1e16 },
      tiny: { boot_seconds: 1e-5 },
      count: 1,
    };
    const result = await capture(['list', '--json'], async () => payload);
    // The same document as earlier releases print it, keys sorted: whole seconds keep their
    // `.0`, and exponents their sign and two digits.
    const recorded =
      '{"count": 1, "dump_seconds": 1.0, "nested": {"boot_seconds": 1e+16}, ' +
      '"restore_seconds": 30.0, "tiny": {"boot_seconds": 1e-05}}';
    expect(result.stdout).toContain(`"data": ${recorded}`);
    expect(JSON.stringify(payload)).not.toContain('1.0');
    expect(result.stdout).toContain('"dump_seconds": 1.0');
    expect(result.stdout).toContain('"restore_seconds": 30.0');
    expect(result.stdout).toContain('"boot_seconds": 1e+16');
    expect(result.stdout).toContain('"boot_seconds": 1e-05');
    expect(result.stdout).toContain('"count": 1');
    expect(parseJsonTranscript(result.stdout, false).envelope.ok).toBe(true);
  });

  test('actual executor prose on stdout is rejected by the transcript harness', async () => {
    const result = await capture(['list', '--json'], async () => {
      process.stdout.write('working\n');
      return { repros: [], count: 0 };
    });
    expect(() => parseJsonTranscript(result.stdout, false)).toThrow(/prose or invalid JSON/);
  });

  test('ready events precede the final envelope and human ready gets no JSON writer', async () => {
    const json = await capture(['ready', '--json'], async (invocation) => {
      invocation.events?.emit({ phase: 'wait', pct: 20, message: 'waiting' });
      invocation.events?.emit({ phase: 'done', terminal: true, message: 'done' });
      return { ready: true };
    });
    const transcript = parseJsonTranscript(json.stdout, true);
    expect(transcript.events).toHaveLength(1);
    expect(transcript.events[0]?.schema).toBe('houston.event.v1');
    expect(transcript.envelope.schema).toBe('houston.ready.v1');
    // What earlier releases printed for the same two events and the same reply: the
    // terminal event is not streamed, and the envelope comes last. `generated_at` is an
    // instant and is kept as `<when>`.
    const recorded = [
      '{"contract": 2, "detail": {}, "level": "info", "message": "waiting", "pct": 20, ' +
        '"phase": "wait", "schema": "houston.event.v1"}',
      '{"contract": 2, "data": {"ready": true}, "error": null, "generated_at": "<when>", ' +
        '"houston_version": "2.0.0", "ok": true, "schema": "houston.ready.v1", "warnings": []}',
    ].join('\n');
    expect(
      json.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).schema),
    ).toEqual(
      recorded
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).schema),
    );
    const human = await capture(['ready'], async (invocation) => {
      expect(invocation.events).toBeNull();
      return { ready: true };
    });
    expect(human.stdout).toBe('');
  });

  test('stable ReproError code and exit reach one final error envelope', async () => {
    const result = await capture(['info', '--json'], async () => {
      throw new NotReadyError('still booting');
    });
    expect(result.code).toBe(5);
    expect(parseJsonTranscript(result.stdout, false).envelope).toMatchObject({
      ok: false,
      error: { code: 'NOT_READY', message: 'still booting' },
    });
  });

  test('an envelope before a later event is rejected', () => {
    expect(() =>
      parseJsonTranscript('{"schema":"houston.ready.v1"}\n{"schema":"houston.event.v1"}\n', true),
    ).toThrow(/final JSON line is an event/);
  });
});
