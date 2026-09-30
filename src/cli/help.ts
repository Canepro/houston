import { Help } from 'commander';
import type { Command } from 'commander';

import { reportsDir } from '../lib/config';

import { COMMAND_SPECS } from './spec-data';
import type { ArgumentSpec, CommandSpec, OptionSpec } from './spec-types';

const ROOT_DESCRIPTION = 'Launch version-matched Rocket.Chat reproduction environments.';
const SKILL_DESCRIPTION = 'Install the agent skill that teaches a caller to drive houston.';
const WIDTH = 96;

function words(text: string, width: number, prefix = ''): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }
    const indent = paragraph.match(/^\s*/u)?.[0] ?? '';
    const available = Math.max(20, width - prefix.length - indent.length);
    let line = '';
    for (const word of paragraph.trim().split(/\s+/u)) {
      if (line !== '' && `${line} ${word}`.length > available) {
        lines.push(`${prefix}${indent}${line}`);
        line = word;
      } else {
        line = line === '' ? word : `${line} ${word}`;
      }
    }
    lines.push(`${prefix}${indent}${line}`);
  }
  return lines;
}

function valueLabel(value: OptionSpec['value'] | ArgumentSpec['value']): string {
  if (value === 'boolean') return '';
  if (value === 'integer') return '<integer>';
  if (value === 'float') return '<number>';
  return '<string>';
}

function displayedDescription(text: string): string {
  return (
    text
      .replaceAll('\b', '')
      .replaceAll('\\[', '[')
      .replaceAll('\\]', ']')
      // `reportsDir()`, a `..` in the home kept as written: `path.join` folded a `..` that
      // the established help keeps.
      .replaceAll('{reports_dir}', reportsDir())
  );
}

function defaultText(item: OptionSpec | ArgumentSpec): string {
  if (item.required) return ' [required]';
  const value = item.defaultValue;
  if (value === undefined || value === null || value === '' || value === false) return '';
  if ('negatablePair' in item && item.negatablePair && value === true) {
    return ` [default: ${item.long.split('/')[0]?.slice(2) ?? 'true'}]`;
  }
  if (item.value === 'float' && typeof value === 'number') {
    return ` [default: ${value.toFixed(1)}]`;
  }
  return ` [default: ${String(value)}]`;
}

function renderRows(
  title: string,
  rows: readonly { label: string; description: string }[],
): string[] {
  const visibleWidth = Math.max(18, ...rows.map((row) => row.label.length));
  const out = [`╭─ ${title} ${'─'.repeat(Math.max(1, WIDTH - title.length - 5))}╮`];
  for (const row of rows) {
    const prefix = `  ${row.label.padEnd(visibleWidth)}  `;
    const wrapped = words(row.description, WIDTH - prefix.length);
    if (wrapped.length === 0) out.push(prefix.trimEnd());
    else {
      out.push(`${prefix}${wrapped[0] ?? ''}`.trimEnd());
      const continuation = ' '.repeat(prefix.length);
      for (const line of wrapped.slice(1)) out.push(line === '' ? '' : `${continuation}${line}`);
    }
  }
  out.push(`╰${'─'.repeat(WIDTH - 1)}╯`);
  return out;
}

function optionRows(spec: CommandSpec): { label: string; description: string }[] {
  const options: ({ kind: 'option'; value: OptionSpec } | { kind: 'json' })[] = spec.options.map(
    (value) => ({ kind: 'option', value }),
  );
  if (spec.json.mode === 'flag') {
    options.splice(spec.json.option?.index ?? options.length, 0, { kind: 'json' });
  }
  const rows: { label: string; description: string }[] = [];
  for (const entry of options) {
    if (entry.kind === 'json') {
      rows.push({ label: '--json', description: spec.json.option?.description ?? '' });
      continue;
    }
    const option = entry.value;
    if (option.hidden) continue;
    const flag = option.negatablePair ? option.long.replace('/', '  ') : option.long;
    const short = option.short === undefined ? '' : ` ${option.short}`;
    const value = valueLabel(option.value);
    rows.push({
      label: `${option.required ? '* ' : ''}${flag}${short}${value === '' ? '' : ` ${value}`}`,
      description: `${displayedDescription(option.description)}${defaultText(option)}`.trim(),
    });
  }
  rows.push({ label: '--help', description: 'Show this message and exit.' });
  return rows;
}

/** A command's Usage line: also the first line of a usage error (`./usage-error`). */
export function commandUsage(spec: CommandSpec): string {
  const args = spec.arguments
    .map((argument) => (argument.required ? `{${argument.name}}` : `[${argument.name}]`))
    .join(' ');
  return `Usage: houston ${spec.path} [OPTIONS]${args === '' ? '' : ` ${args}`}`;
}

export function renderCommandHelp(spec: CommandSpec): string {
  const out = ['', ` ${commandUsage(spec)}`, ''];
  out.push(...words(displayedDescription(spec.description), WIDTH, ' '), '');
  if (spec.arguments.length > 0) {
    out.push(
      ...renderRows(
        'Arguments',
        spec.arguments.map((argument) => ({
          label: `${argument.required ? '* ' : ''}${argument.name} ${valueLabel(argument.value)}`,
          description: `${argument.description}${defaultText(argument)}`.trim(),
        })),
      ),
      '',
    );
  }
  out.push(...renderRows('Options', optionRows(spec)), '');
  return `${out.join('\n')}\n`;
}

export function renderRootHelp(): string {
  const out = [
    '',
    ' Usage: houston [OPTIONS] COMMAND [ARGS]...',
    '',
    ` ${ROOT_DESCRIPTION}`,
    '',
    ...renderRows('Options', [
      { label: '--version -V', description: 'print the installed houston version and exit' },
      { label: '--help', description: 'Show this message and exit.' },
    ]),
    '',
  ];
  const top: { label: string; description: string }[] = COMMAND_SPECS.filter(
    (spec) => !spec.path.includes(' '),
  ).map((spec) => ({
    label: spec.path,
    description: displayedDescription(spec.description.split('\n')[0] as string),
  }));
  top.push({ label: 'skill', description: SKILL_DESCRIPTION });
  out.push(...renderRows('Commands', top), '');
  return `${out.join('\n')}\n`;
}

export function renderSkillHelp(): string {
  return `${[
    '',
    ' Usage: houston skill [OPTIONS] COMMAND [ARGS]...',
    '',
    ` ${SKILL_DESCRIPTION}`,
    '',
    ...renderRows('Options', [{ label: '--help', description: 'Show this message and exit.' }]),
    '',
    ...renderRows(
      'Commands',
      COMMAND_SPECS.filter((spec) => spec.path.startsWith('skill ')).map((spec) => ({
        label: spec.path.split(' ')[1] as string,
        description: spec.description.split('\n')[0] as string,
      })),
    ),
    '',
  ].join('\n')}\n`;
}

/** Commander calls this for every --help; rendering still reads the same spec. */
export class HoustonHelp extends Help {
  constructor(private readonly byCommand: WeakMap<Command, CommandSpec | 'root' | 'skill'>) {
    super();
  }

  override formatHelp(command: Command, _helper: Help): string {
    const found = this.byCommand.get(command);
    if (found === 'root' || found === undefined) return renderRootHelp();
    if (found === 'skill') return renderSkillHelp();
    return renderCommandHelp(found);
  }
}
