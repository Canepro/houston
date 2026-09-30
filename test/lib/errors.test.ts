import * as fs from 'fs';
import * as path from 'path';

import {
  AuthorityGateError,
  ConflictError,
  CreateFailedError,
  DockerError,
  ERROR_CLASSES,
  EXIT_CODES,
  GATE_CODES,
  MissingRecordError,
  NotFoundError,
  NotReadyError,
  PreflightError,
  RAISED_GATE_CODES,
  ReproError,
  ValidationError,
  asPayload,
  errorCodes,
} from '../../src/lib/errors';

describe('the taxonomy', () => {
  // One table, three consumers. The CLI exit code, the web status and the machine
  // payload all come from here, so the numbers are the contract and not an accident.
  it.each([
    [ReproError, 400, 'REPRO_ERROR', 1],
    [ValidationError, 400, 'VALIDATION_FAILED', 2],
    [ConflictError, 409, 'CONFLICT', 8],
    [NotFoundError, 404, 'NOT_FOUND', 4],
    [NotReadyError, 409, 'NOT_READY', 5],
    [DockerError, 502, 'ENGINE_UNAVAILABLE', 3],
    [PreflightError, 409, 'PREFLIGHT_FAILED', 3],
    [CreateFailedError, 500, 'CREATE_FAILED', 7],
    [AuthorityGateError, 403, 'GATE', 6],
  ])('%p carries its status, code and exit code onto the instance', (Cls, status, code, exit) => {
    const exc = new (Cls as typeof ReproError)('boom');
    expect(exc.httpStatus).toBe(status);
    expect(exc.code).toBe(code);
    expect(exc.exitCode).toBe(exit);
  });

  it('keeps NotReadyError and CreateFailedError distinct', () => {
    // 5 means "still unknown, the clock ran out"; 7 means "known dead, stop now".
    // Collapsing them is what makes callers wait out a run that had already failed.
    expect(new NotReadyError('').exitCode).not.toBe(new CreateFailedError('').exitCode);
  });

  it('survives instanceof across the hierarchy', () => {
    const exc = new ValidationError('bad port');
    expect(exc).toBeInstanceOf(ValidationError);
    expect(exc).toBeInstanceOf(ReproError);
    expect(exc).toBeInstanceOf(Error);
    expect(exc.name).toBe('ValidationError');
  });

  it('lets a caller override the code without moving the class', () => {
    // AuthorityGateError takes its code as an argument, which is the whole reason
    // RAISED_GATE_CODES has to exist separately from the class walk.
    const exc = new ReproError('x', { code: 'GATE_CLOUD_SPEND' });
    expect(exc.code).toBe('GATE_CLOUD_SPEND');
    expect(exc.httpStatus).toBe(400);
  });
});

describe('MissingRecordError', () => {
  // BOTH bases in earlier releases, deliberately: 404 for `serve`, and still what a dozen callers
  // that mean "this workspace has no record" already catch.
  it('is a NotFoundError so serve answers 404 rather than 500', () => {
    const exc = new MissingRecordError('no repro.json');
    expect(exc).toBeInstanceOf(NotFoundError);
    expect(exc.httpStatus).toBe(404);
    expect(exc.code).toBe('NOT_FOUND');
  });

  it('is still recognisable as a missing file', () => {
    const exc = new MissingRecordError('no repro.json');
    expect(exc.isFileNotFound).toBe(true);
    expect(exc.errno).toBe('ENOENT');
  });
});

describe('AuthorityGateError', () => {
  it('carries what to ask a HUMAN to run', () => {
    const exc = new AuthorityGateError('not approved', {
      kind: 'cluster',
      subject: 'arn:aws:eks:eu-west-1:1234:cluster/x',
      approveWith: 'houston cluster approve 1234',
      code: 'GATE_UNAPPROVED_CLUSTER',
    });
    expect(exc.code).toBe('GATE_UNAPPROVED_CLUSTER');
    expect(exc.asGate()).toEqual({
      kind: 'cluster',
      subject: 'arn:aws:eks:eu-west-1:1234:cluster/x',
      approve_with: 'houston cluster approve 1234',
    });
  });

  it('inlines the gate into the payload, where it is the only thing that matters', () => {
    // `as_gate()` had no caller at all in an earlier build, so `approve_with` -- the one
    // thing a gate exists to communicate -- never left the process.
    const exc = new AuthorityGateError('nope', { kind: 'retention', approveWith: 'do this' });
    const payload = asPayload(exc);
    expect(payload.gate).toEqual({ kind: 'retention', subject: '', approve_with: 'do this' });
  });
});

describe('the machine-readable payload', () => {
  it('reports code and kind, and code is the stable half', () => {
    const payload = asPayload(new ConflictError('port taken'));
    expect(payload).toEqual({ error: 'port taken', code: 'CONFLICT', kind: 'ConflictError' });
  });

  it('includes details when there are any, and omits the key when there are none', () => {
    expect(asPayload(new ValidationError('x', { details: { port: 9944 } })).details).toEqual({
      port: 9944,
    });
    expect(asPayload(new ValidationError('x')).details).toBeUndefined();
  });
});

describe('the published error-code set', () => {
  it('advertises every class this build can raise, plus the reachable gates', () => {
    const codes = errorCodes();
    for (const cls of ERROR_CLASSES) {
      if (cls.advertised) expect(codes).toContain(cls.code);
    }
    for (const gate of RAISED_GATE_CODES) expect(codes).toContain(gate);
  });

  it('does NOT publish the whole gate registry', () => {
    // Most of GATE_CODES is unreachable. Advertising a code nothing can produce teaches
    // a caller to write a branch that never runs -- the exact failure the published set
    // exists to prevent.
    const codes = new Set(errorCodes());
    const unreachable = Object.keys(GATE_CODES).filter((c) => !RAISED_GATE_CODES.includes(c));
    expect(unreachable.length).toBeGreaterThan(0);
    for (const code of unreachable) expect(codes.has(code)).toBe(false);
  });

  it('is sorted and free of duplicates', () => {
    const codes = errorCodes();
    expect(codes).toEqual([...codes].sort());
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('ERROR_CLASSES', () => {
  /**
   * Earlier releases derived the published code set by walking the class's subclasses, so
   * a new subclass could not be forgotten. JavaScript keeps no subclass registry, so the
   * walk had to become a list -- and a list is exactly the thing that drifts. This reads the
   * module's own source and fails when an exported error class is missing from it.
   */
  it('names every error class this module exports', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'lib', 'errors.ts'),
      'utf8',
    );
    const exported = [...source.matchAll(/^export class (\w+)/gm)].map((m) => m[1] as string);
    expect(exported.length).toBeGreaterThan(5);
    const listed = new Set(ERROR_CLASSES.map((c) => c.name));
    expect([...exported].filter((name) => !listed.has(name))).toEqual([]);
  });
});

describe('EXIT_CODES', () => {
  it('maps every exit code the taxonomy can produce', () => {
    for (const cls of ERROR_CLASSES) {
      expect(EXIT_CODES[cls.exitCode]).toBeDefined();
    }
    expect(EXIT_CODES[0]).toBe('ok');
  });
});

describe('the web status of each domain failure', () => {
  it('maps the five domain classes onto the statuses the web layer answers with', () => {
    expect(new ValidationError('x').httpStatus).toBe(400);
    expect(new ConflictError('x').httpStatus).toBe(409);
    expect(new NotFoundError('x').httpStatus).toBe(404);
    expect(new NotReadyError('x').httpStatus).toBe(409);
    expect(new DockerError('x').httpStatus).toBe(502);
    expect(new ValidationError('x')).toBeInstanceOf(ReproError);
  });
});
