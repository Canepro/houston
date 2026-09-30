/**
 * INVARIANT: every side effect that outlives a SIGKILL is journalled.
 *
 * MECHANISM: ts-morph.
 *
 * This one genuinely needs the tree. The claim is about EVERY function in the package at
 * once -- "anything that turns the rate limiter off records a note that turns it back
 * on" -- and there is no call to drive: the offending function is the one nobody wrote
 * yet. Driving it means enumerating the arming sites, which IS the walk.
 *
 * Earlier releases' version of this records that it passed for the wrong reason twice:
 * first because it was a hardcoded four-function list that the seeder and the config import
 * were simply outside, and then because its guard searched the source for the setting's
 * constant name while both of those files spelled the setting as a bare literal. Both failures are the same shape -- a text search matching a
 * SPELLING rather than a call. This walks the calls: `setSetting(..., <setting>, false)`
 * is an arming whichever name the setting arrives under, and `journal.record(<KIND>)`
 * inside the same function is the note that undoes it.
 */
import * as path from 'node:path';

import {
  Project,
  SyntaxKind,
  type FunctionDeclaration,
  type Node,
  type SourceFile,
} from 'ts-morph';

import * as journal from '../../../src/core/journal';

const ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Setting -> the journal kind whose repair puts it back, and the names it travels under.
 *
 * The aliases are the point. `seed/apply.ts` and `core/configimport.ts` each define their
 * own `const RATE_LIMITER = 'API_Enable_Rate_Limiter'`, `lib/config.ts` exports it as
 * `RC_RATE_LIMITER_SETTING`, and earlier releases' equivalent search missed both files
 * for exactly this reason.
 */
const GUARDED: { setting: string; kind: string; kindName: string; aliases: string[] }[] = [
  {
    setting: 'API_Enable_Rate_Limiter',
    kind: journal.RATE_LIMITER_OFF,
    kindName: 'RATE_LIMITER_OFF',
    aliases: ['RATE_LIMITER', 'RC_RATE_LIMITER_SETTING'],
  },
  {
    setting: journal.EMAIL_2FA_SETTING,
    kind: journal.EMAIL_2FA_OFF,
    kindName: 'EMAIL_2FA_OFF',
    aliases: ['EMAIL_2FA_SETTING', 'EMAIL_2FA'],
  },
];

/** A call that arms something a kill must not strand, and the kind for each. */
const ARMING_CALLS: { call: string; kind: string; kindName: string }[] = [
  { call: 'constrain.apply', kind: journal.CONSTRAINTS_APPLIED, kindName: 'CONSTRAINTS_APPLIED' },
  { call: 'mongoprof.start', kind: journal.MONGO_PROFILER_ON, kindName: 'MONGO_PROFILER_ON' },
];

function sources(): SourceFile[] {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths([path.join(ROOT, 'src', '**', '*.ts')]);
  return project.getSourceFiles();
}

/** Whether one argument names `setting`, as a literal or through one of its aliases. */
function namesSetting(text: string, setting: string, aliases: readonly string[]): boolean {
  const literal = /^'(?<value>[^']*)'$|^"(?<alt>[^"]*)"$/u.exec(text);
  const value = literal?.groups?.value ?? literal?.groups?.alt;
  if (value !== undefined) return value === setting;
  const last = text.split('.').at(-1) ?? text;
  return aliases.includes(last);
}

/**
 * Every function in one file, and whether what it arms is journalled.
 *
 * FOLLOWED THROUGH THE CALLS. `seed/apply.ts` arms email-2FA inside `quiesceSettings` and records
 * the note in the function that calls it, three lines above the `finally` that puts it back;
 * requiring the note in the arming function itself would call that correct code a defect, which is
 * the failure following the calls exists to avoid.
 */
function offendersIn(file: SourceFile): string[] {
  const offenders: string[] = [];
  const where = path.basename(file.getFilePath());
  const declared = new Map<string, FunctionDeclaration>();
  for (const fn of file.getFunctions()) {
    const name = fn.getName();
    if (name !== undefined) declared.set(name, fn);
  }

  function kindsRecordedIn(node: Node): Set<string> {
    return new Set(
      node
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((call) => call.getExpression().getText().endsWith('journal.record'))
        .map((call) => call.getArguments()[0]?.getText().split('.').at(-1) ?? ''),
    );
  }

  /** Kinds recorded by `name`, or by anything in this file that reaches it. */
  function kindsAroundCallsTo(name: string): Set<string> {
    const found = new Set<string>();
    for (const [callerName, caller] of declared) {
      if (callerName === name) continue;
      const reaches = caller
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .some((call) => call.getExpression().getText().split('.').at(-1) === name);
      if (reaches) for (const kind of kindsRecordedIn(caller)) found.add(kind);
    }
    return found;
  }

  const functions: Node[] = [
    ...file.getFunctions(),
    ...file.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...file.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
  ];
  for (const fn of functions) {
    const calls = fn.getDescendantsOfKind(SyntaxKind.CallExpression);
    const ownName =
      fn.getKind() === SyntaxKind.FunctionDeclaration
        ? (fn.asKindOrThrow(SyntaxKind.FunctionDeclaration).getName() ?? '')
        : '';
    const recorded = kindsRecordedIn(fn);
    if (ownName !== '') for (const kind of kindsAroundCallsTo(ownName)) recorded.add(kind);
    const label = `${where}:${ownName !== '' ? ownName : `line ${String(fn.getStartLineNumber())}`}`;

    for (const { setting, kindName, aliases } of GUARDED) {
      // ARMED = this setting is set to FALSE by ONE call. Asking whether the function
      // mentions the setting anywhere AND contains `false` anywhere was true of the big
      // functions by luck and false of the small ones by luck.
      const armed = calls.some((call) => {
        const args = call.getArguments().map((argument) => argument.getText());
        return args.some((text) => namesSetting(text, setting, aliases)) && args.includes('false');
      });
      if (armed && !recorded.has(kindName)) {
        offenders.push(`${label} disables ${setting} and records no ${kindName}`);
      }
    }
    for (const { call, kindName } of ARMING_CALLS) {
      const arms = calls.some((node) => node.getExpression().getText() === call);
      if (arms && !recorded.has(kindName)) {
        offenders.push(`${label} calls ${call}() and records no ${kindName}`);
      }
    }
  }
  return offenders;
}

describe('a side effect that outlives a kill is journalled', () => {
  it('recognises an arming that records nothing', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const planted = project.createSourceFile(
      'planted.ts',
      `
export async function turnOffTheLimiter(url: string, auth: string) {
  await setSetting(url, auth, '', 'API_Enable_Rate_Limiter', false);
}
`,
    );
    // THE POSITIVE CONTROL. Earlier releases' version of this walk twice reported a clean tree
    // while matching nothing at all, both times because it searched for a spelling.
    expect(offendersIn(planted)).toEqual([
      'planted.ts:turnOffTheLimiter disables API_Enable_Rate_Limiter and records no RATE_LIMITER_OFF',
    ]);
  });

  it('accepts an arming whose note is recorded in the same function', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const planted = project.createSourceFile(
      'guarded.ts',
      `
export async function turnOffTheLimiter(url: string, auth: string, workspace: string) {
  const note = journal.record(journal.RATE_LIMITER_OFF, workspace);
  await setSetting(url, auth, '', 'API_Enable_Rate_Limiter', false);
  journal.clear(note);
}
`,
    );
    expect(offendersIn(planted)).toEqual([]);
  });

  it('finds none in the package', () => {
    const files = sources().filter(
      // `journal.ts` is the REPAIR side by definition: `repair` puts these settings back,
      // so it mentions every one of them and journals none. Excluded by name rather than
      // by a cleverer predicate, because that is the honest reason.
      (file) => path.basename(file.getFilePath()) !== 'journal.ts',
    );
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap(offendersIn)).toEqual([]);
  });

  it('keeps the kinds the walk depends on, so a rename cannot make it a no-op', () => {
    for (const kind of [
      'RATE_LIMITER_OFF',
      'EMAIL_2FA_OFF',
      'CONSTRAINTS_APPLIED',
      'MONGO_PROFILER_ON',
      'RC_METRICS_ON',
    ] as const) {
      expect(typeof journal[kind]).toBe('string');
      expect(journal.KINDS).toContain(journal[kind]);
    }
  });
});
