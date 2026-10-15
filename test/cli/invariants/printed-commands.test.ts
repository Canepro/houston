/**
 * INVARIANT: every command this tool tells somebody to run exists.
 *
 * MECHANISM: ts-morph over the production sources, checked against the COMMAND REGISTRY.
 *
 * A message naming a command that does not exist is worse than no message: it reads as
 * authoritative and costs the reader a round trip to find out otherwise. This is not
 * hypothetical -- the migration and a doctor check both said `houston edge up`, and the
 * verb is `start`, so the one instruction printed at somebody whose edge had just stopped
 * was the one thing they could not run.
 *
 * Earlier releases read every source file in the package as TEXT, which reads PROSE as well
 * as code: the guard's own doc comment had to be written around the scan, and its sibling guard over the
 * edge package recorded a case where exactly that happened. Here the walk
 * collects string LITERALS and template heads from the syntax tree, so a sentence in a
 * comment explaining that `houston edge up` does not exist is not itself an offence.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Project, SyntaxKind, type SourceFile } from 'ts-morph';

import { COMMAND_SPECS } from '../../../src/cli/spec-data';
import type { CommandSpec } from '../../../src/cli/spec-types';

const ROOT = path.resolve(__dirname, '..', '..', '..');

function productionSources(): SourceFile[] {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths([path.join(ROOT, 'src', '**', '*.ts')]);
  return project.getSourceFiles();
}

/** Every piece of prose this build can print, from the tree rather than from the file. */
function printedText(file: SourceFile): { text: string; line: number }[] {
  const found: { text: string; line: number }[] = [];
  for (const node of file.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    found.push({ text: node.getLiteralValue(), line: node.getStartLineNumber() });
  }
  for (const node of file.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    found.push({ text: node.getLiteralValue(), line: node.getStartLineNumber() });
  }
  for (const node of file.getDescendantsOfKind(SyntaxKind.TemplateExpression)) {
    // THE LITERAL SPANS, not `getText()`. A template's own delimiting backtick is part of
    // its text, and reading that made every `` `houston cannot bind…` `` message look like
    // a backticked instruction -- eight false offenders, all of them prose.
    const spans = [
      node.getHead().getLiteralText(),
      ...node.getTemplateSpans().map((span) => span.getLiteral().getLiteralText()),
    ];
    found.push({ text: spans.join(' '), line: node.getStartLineNumber() });
  }
  return found;
}

/** Commands the CLI really registers, top-level verb first. */
function knownVerbs(): Set<string> {
  return new Set(COMMAND_SPECS.map((spec) => spec.path.split(' ')[0] ?? ''));
}

/** A run of code in a markdown document, and the line it starts on. */
interface CodePiece {
  text: string;
  line: number;
  inline: boolean;
}

/**
 * The CODE in a markdown document -- fenced blocks line by line, then inline spans -- and never
 * its prose, which says "houston built this cluster" and would read as a command named `built`.
 * The fences are blanked before the spans are read, so a backtick inside a block cannot pair
 * with one outside it; and a span may wrap a line, because prose wraps. A span that could not
 * cross a newline let the closing backtick of one pair with the opening of the next, and the
 * README read as `houston did`.
 */
function codeOf(body: string): CodePiece[] {
  const pieces: CodePiece[] = [];
  const lineAt = (index: number): number => body.slice(0, index).split('\n').length;
  const blanked = body.replace(/```[^\n]*\n([\s\S]*?)```/gu, (whole, inner: string, at: number) => {
    let line = lineAt(at) + 1;
    let pending = '';
    let startedAt = line;
    for (const raw of inner.split('\n')) {
      if (pending === '') startedAt = line;
      if (raw.endsWith('\\')) pending += `${raw.slice(0, -1)} `;
      else {
        pieces.push({ text: pending + raw, line: startedAt, inline: false });
        pending = '';
      }
      line += 1;
    }
    return whole.replace(/[^\n]/gu, ' ');
  });
  for (const match of blanked.matchAll(/`([^`]+)`/gu)) {
    pieces.push({
      text: (match[1] ?? '').replace(/\n/gu, ' '),
      line: lineAt(match.index),
      inline: true,
    });
  }
  return pieces;
}

/** The words after `houston` in each invocation a piece of code holds. */
function invocations(piece: CodePiece, known: Set<string>): string[][] {
  const found: string[][] = [];
  const text = piece.text.replace(/'[^']*'|"[^"]*"/gu, 'QUOTED').replace(/(^|\s)#.*$/u, '$1');
  for (const segment of text.split(/&&|\|\||;|\\?\||\$\(|\)/u)) {
    const words = segment
      .replace(/\s(?:\d?>>?|<)(?:\s|&).*$/u, '')
      .trim()
      .split(/\s+/u)
      .map((word) => word.replace(/[[\]]/gu, ''))
      .filter((word) => word !== '');
    while (/^(?:[A-Za-z_][A-Za-z0-9_]*=|sudo$|exec$)/u.test(words[0] ?? '')) words.shift();
    const head = words[0] ?? '';
    if (head === 'houston' || head.endsWith('/houston')) found.push(words.slice(1));
    // The shorthand a table cell uses -- `seed --scale --clear` -- is an invocation too, when it
    // starts with a real verb and carries a flag: that is exactly where the README went wrong.
    else if (piece.inline && known.has(head) && words.some((word) => word.startsWith('-'))) {
      found.push(words);
    }
  }
  return found;
}

/** A placeholder standing where a word would, which there is nothing to check against. */
function isPlaceholder(word: string): boolean {
  return /^(?:<.*|\{\{.*|\.\.\.|…|\$.*)$/u.test(word);
}

/** What is wrong with one invocation, or null when the command and every flag are real. */
function problemWith(words: string[]): string | null {
  const first = words[0] ?? '';
  if (first === '' || isPlaceholder(first)) return null;
  if (first.startsWith('-')) {
    return ['--version', '--help'].includes(first) ? null : `the root takes no ${first}`;
  }
  const two = `${first} ${words[1] ?? ''}`;
  const specs: readonly CommandSpec[] = COMMAND_SPECS;
  const spec =
    specs.find((candidate) => candidate.path === two) ??
    specs.find((candidate) => candidate.path === first);
  if (spec === undefined) return `no command ${first}`;
  const rest = words.slice(spec.path.split(' ').length);
  const action = spec.arguments[0];
  const next = rest[0] ?? '';
  if (action?.name === 'action' && next !== '' && !next.startsWith('-') && !isPlaceholder(next)) {
    const actions = action.description.split('|').map((word) => word.trim());
    if (!actions.includes(next)) return `${spec.path} has no action ${next}`;
  }
  const flags = new Set(['--help']);
  if (spec.json.mode === 'flag') flags.add('--json');
  for (const option of spec.options) {
    for (const long of option.long.split('/')) flags.add(long);
    if (option.short !== undefined) flags.add(option.short);
  }
  for (const word of rest) {
    if (!word.startsWith('-') || word === '-' || word === '--' || /^-\d/u.test(word)) continue;
    const flag = word.split('=')[0] ?? word;
    if (!flags.has(flag)) return `${spec.path} has no ${flag}`;
  }
  return null;
}

describe('a printed instruction names a command that exists', () => {
  it('has a registry to check against at all', () => {
    expect(COMMAND_SPECS).toHaveLength(41);
    expect(knownVerbs().size).toBeGreaterThan(30);
  });

  it('never prints a `houston <verb>` that is not registered', () => {
    // BACKTICKED only, which is this codebase's own convention for "run this". Prose
    // mentions the tool by name constantly -- "another houston edge is already running"
    // is a sentence, not an instruction -- and matching it would make the check noisy
    // enough to be switched off. The guard in earlier releases drew the line in the same place.
    const known = knownVerbs();
    const wrong: string[] = [];
    let seen = 0;
    for (const file of productionSources()) {
      for (const { text, line } of printedText(file)) {
        for (const match of text.matchAll(/`houston ([a-z][a-z0-9-]*)/gu)) {
          seen += 1;
          const verb = match[1] as string;
          if (!known.has(verb)) {
            wrong.push(`${path.basename(file.getFilePath())}:${String(line)} houston ${verb}`);
          }
        }
      }
    }
    // The positive control: a walk finding no instructions at all would pass silently,
    // which is exactly how the earlier guard narrowed when the CLI became a package.
    expect(seen).toBeGreaterThan(30);
    expect(wrong).toEqual([]);
  });

  it('never prints a backticked `--flag` that no houston command has', () => {
    // The same convention, one level down: a bare `--flag` in backticks is an instruction
    // too. doctor told people to use `--ctx.context <other>`, a flag no command has ever
    // had, and the verb check above never saw it because no `houston` preceded it.
    const known = new Set(['--help', '--version', '--json']);
    for (const spec of COMMAND_SPECS) {
      for (const option of spec.options) for (const long of option.long.split('/')) known.add(long);
    }
    // Flags that belong to another tool and are quoted as that tool's: each names the
    // tool it is for, so a new entry here is a decision and not a shrug.
    const foreign = new Map([['--disable', 'k3s install (traefik, servicelb)']]);
    for (const flag of foreign.keys()) known.add(flag);
    const wrong: string[] = [];
    let seen = 0;
    for (const file of productionSources()) {
      for (const { text, line } of printedText(file)) {
        for (const match of text.matchAll(/`(--[a-z][a-z0-9.-]*)/gu)) {
          seen += 1;
          const flag = match[1] as string;
          if (!known.has(flag))
            wrong.push(`${path.basename(file.getFilePath())}:${String(line)} ${flag}`);
        }
      }
    }
    expect(seen).toBeGreaterThan(10);
    expect(wrong).toEqual([]);
  });

  it('never prints an `edge` action the command does not handle', () => {
    const edge = COMMAND_SPECS.find((spec) => spec.path === 'edge');
    expect(edge).toBeDefined();
    const declared = String(edge?.arguments[0]?.description ?? '')
      .split('|')
      .map((word) => word.trim());
    expect(declared).toContain('start');
    expect(declared).toContain('status');

    const wrong: string[] = [];
    for (const file of productionSources()) {
      for (const { text, line } of printedText(file)) {
        for (const match of text.matchAll(/`houston edge ([a-z][a-z0-9-]*)/gu)) {
          const action = match[1] as string;
          if (!declared.includes(action)) {
            wrong.push(
              `${path.basename(file.getFilePath())}:${String(line)} houston edge ${action}`,
            );
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('never teaches a runtime a context already implies', () => {
    const offenders: string[] = [];
    for (const file of productionSources()) {
      for (const { text, line } of printedText(file)) {
        if (text.includes('--runtime kubernetes') && text.includes('--context')) {
          offenders.push(`${path.basename(file.getFilePath())}:${String(line)}`);
        }
      }
    }
    // `--context` has implied Kubernetes since `inferRuntime` landed. A hint that teaches
    // otherwise is not merely verbose; it is the tool contradicting itself at the one
    // place a first-timer is most likely to copy from.
    expect(offenders).toEqual([]);
  });

  it('ships a cloud guide whose commands are all real', () => {
    const guide = path.join(ROOT, 'data', 'docs', 'eks.md');
    expect(fs.existsSync(guide)).toBe(true);
    const body = fs.readFileSync(guide, 'utf8');
    expect(body.split('\n').length).toBeGreaterThan(100);

    const code = codeOf(body)
      .map((piece) => piece.text)
      .join('\n');
    const known = knownVerbs();
    const used = new Set(
      [...code.matchAll(/\bhouston ([a-z][a-z-]*)/gu)].map((m) => m[1] as string),
    );
    expect(used.size).toBeGreaterThan(3);
    expect([...used].filter((verb) => !known.has(verb))).toEqual([]);

    // AND THE ACTION AFTER IT. `houston cluster prepair` passes the check above --
    // `cluster` is a real command -- so a renamed action would sail through the very test
    // written to stop the guide rotting. Measured: it did.
    const clusterSpec = COMMAND_SPECS.find((spec) => spec.path === 'cluster');
    const actions = new Set(
      String(clusterSpec?.arguments[0]?.description ?? '')
        .split('|')
        .map((word) => word.trim()),
    );
    expect(actions.size).toBeGreaterThan(3);
    const named = new Set(
      [...code.matchAll(/\bhouston cluster ([a-z][a-z-]*)/gu)].map((m) => m[1] as string),
    );
    expect([...named].filter((action) => !actions.has(action))).toEqual([]);
  });
});

describe('the documents name only commands and flags that exist', () => {
  // The guard above covers what the BUILD prints; this one covers what the documents teach,
  // which a reader copies just as readily. The README told people to run `seed --scale
  // --clear` when the flag is `--clear-scale`, and the skill taught an agent `tls-status
  // --json` on a command that has no `--json`: each is a first command that fails with a usage
  // error. Every shipped document is read, so a new guide is covered the day it lands.
  const documents = [
    'README.md',
    'CONTRIBUTING.md',
    path.join('tools', 'skill', 'SKILL.template.md'),
    ...fs
      .readdirSync(path.join(ROOT, 'data', 'docs'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => path.join('data', 'docs', name)),
  ];

  it('checks every invocation in them against the registry', () => {
    const known = knownVerbs();
    const wrong: string[] = [];
    let seen = 0;
    for (const document of documents) {
      const body = fs.readFileSync(path.join(ROOT, document), 'utf8');
      for (const piece of codeOf(body)) {
        for (const words of invocations(piece, known)) {
          seen += 1;
          const problem = problemWith(words);
          if (problem !== null) wrong.push(`${document}:${String(piece.line)} ${problem}`);
        }
      }
    }
    // The positive control: an extraction that found nothing would pass on any text at all.
    expect(seen).toBeGreaterThan(150);
    expect(wrong).toEqual([]);
  });

  it('knows a wrong flag, a wrong action and a wrong verb when it sees one', () => {
    const check = (text: string): string | null => {
      const [words] = invocations({ text, line: 1, inline: false }, knownVerbs());
      return problemWith(words ?? []);
    };
    expect(check('houston seed --name t1 --scale users=10 --clear')).toBe('seed has no --clear');
    expect(check('houston tls-status --name t1 --json')).toBe('tls-status has no --json');
    expect(check('houston cluster prepair support')).toBe('cluster has no action prepair');
    expect(check('houston edge up')).toBe('edge has no action up');
    expect(check('houston boot -v 8.5.1')).toBe('no command boot');
    expect(check('houston -h')).toBe('the root takes no -h');
    expect(check('HOUSTON_HOME=/tmp/h bin/houston up -v 8.5.1 --name t1 --wait --json')).toBeNull();
    expect(check('houston skill install --host claude --force')).toBeNull();
    expect(check(`houston api --name t1 -d '{"a": 1}' POST /api/v1/x | jq .`)).toBeNull();
    expect(check('houston <command> --help')).toBeNull();
  });
});
