/**
 * The established YAML 1.1 emission, reproduced: a safe representer, a serializer, a
 * resolver and an emitter, for the values the two writers here hand it.
 *
 * Both YAML files earlier releases wrote -- a workspace's `docker-compose.yml` (`compose.ts`)
 * and `config.yaml` (`config.ts`) -- were written here by the `yaml` package, whose emitter
 * is a different program with different choices: it double-quotes where the established
 * files single-quote (`PORT: "3000"` against `'3000'`), never folds a long scalar at the
 * 80th column, writes non-ASCII raw where the established files escape it, quotes `1e8`,
 * `y` and `N` that this module's resolver leaves plain, spells an empty key `""` where the
 * established files hold the complex `? ''`, indents a list under its key, names anchors
 * `&a1` where the Serializer names them `&id001`, and escapes in lower case. Every such
 * file read back to the same value, but every `env --set` of a workspace an earlier release
 * made rewrote 7 to 16 of its lines, and every `config set` the whole of config.yaml.
 * Options were tried against the package first and cannot close it: the quote rules, the
 * fold points and the complex-key rule are the emitter's own code.
 *
 * So this is that emitter, state for state and writer for writer, with the one
 * configuration both call sites use: block style, keys in their own order, indent 2, width
 * 80, non-ASCII escaped, no explicit start or end, no version or tag directives. The flow
 * and canonical branches the emitter has are kept, since an empty collection is written in
 * flow style (`[]`, `{}`) and the checks share them. The emitter measures a string in code
 * points, so every length, index and column here counts code points, not UTF-16 units.
 *
 * The tag a JavaScript value is represented with:
 *   - `null` and `undefined` are `!!null`; a mapping entry whose value is `undefined` is
 *     left out, as the package left it out;
 *   - a string is a `!!str`, a boolean a `!!bool`, a bigint an `!!int`;
 *   - a number is an `!!int` when it is integral, and a `!!float` otherwise or when it is -0
 *     (the int readers here return 0 for `-0`, so a -0 can only be a float's). A float that
 *     holds an integral value (`1.0`) is not recoverable from a number, and is written as
 *     the int, unless it arrives as a `JsonFloat`, which is always the `!!float` it wraps;
 *   - a `Uint8Array` is `!!binary`, a `Set` a `!!set`, a `Date` a `!!timestamp`, a date or
 *     a datetime as `dateText` spells it;
 *   - an array is a `!!seq`, a `Map` a `!!map` with its keys as they are, and a plain
 *     object a `!!map` of its own enumerable string keys in their order.
 * An object met twice is ONE node, which the Serializer anchors; a string, number, boolean
 * or `Uint8Array` never is.
 */

import { types } from 'node:util';

import { JsonFloat, floatString } from './float-text';

/**
 * One implicit resolver: the tag a plain scalar reads as when `regexp` matches it,
 * consulted for a scalar whose first character is one of `first`. `regexp` is anchored at
 * the start and ends in `\n?$`, a `$` that also matches before a final line feed.
 */
export type ImplicitResolver = readonly [tag: string, regexp: RegExp, first: string];

/** What the dump needs to know that a JavaScript value does not carry. */
export interface SafeDumpOptions {
  /**
   * The text written for a Date: the ISO text of the date, or of the datetime (a space
   * between), that the Date stands for. Without it, or where it answers undefined, a Date
   * is the UTC datetime of its instant.
   */
  readonly dateText?: (value: Date) => string | undefined;
  /**
   * Extra implicit resolvers, consulted after the resolver's own and in this order. A
   * string one of them matches is not plain to the emitter, which quotes it by its normal
   * rules; `compose.ts` passes the scalars docker compose's reader types. Without them,
   * this is the plain safe dump.
   */
  readonly implicitResolvers?: readonly ImplicitResolver[];
}

// ---------------------------------------------------------------------------------------
// Nodes and events, as far as a safe dump makes them.

type Style = null | '' | "'" | '"' | '|' | '>';

interface ScalarNode {
  readonly kind: 'scalar';
  readonly tag: string;
  readonly value: string;
  readonly style: Style;
}

interface SequenceNode {
  readonly kind: 'sequence';
  readonly tag: string;
  readonly value: YamlNode[];
  flowStyle: boolean;
}

interface MappingNode {
  readonly kind: 'mapping';
  readonly tag: string;
  readonly value: [YamlNode, YamlNode][];
  flowStyle: boolean;
}

type YamlNode = ScalarNode | SequenceNode | MappingNode;

type YamlEvent =
  | { readonly type: 'StreamStart' }
  | { readonly type: 'StreamEnd' }
  | { readonly type: 'DocumentStart'; readonly explicit: boolean }
  | { readonly type: 'DocumentEnd'; readonly explicit: boolean }
  | { readonly type: 'Alias'; readonly anchor: string | null }
  | {
      readonly type: 'Scalar';
      readonly anchor: string | null;
      readonly tag: string | null;
      readonly implicit: readonly [boolean, boolean];
      readonly value: string;
      readonly style: Style;
    }
  | {
      readonly type: 'SequenceStart' | 'MappingStart';
      readonly anchor: string | null;
      readonly tag: string | null;
      readonly implicit: boolean;
      readonly flowStyle: boolean;
    }
  | { readonly type: 'SequenceEnd' | 'MappingEnd' };

/** A `RepresenterError` or an `EmitterError`, named as the error line shows it. */
function yamlError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

// ---------------------------------------------------------------------------------------
// The resolver: the implicit tag a plain scalar's text would read as.
//
// A pattern's `$` also matches before a final line feed, so `yes\n` is a bool; `\n?$` is
// that `$` here. The verbose-mode whitespace is taken out; the character classes keep theirs.

const IMPLICIT: readonly (readonly [string, RegExp, string])[] = [
  [
    'tag:yaml.org,2002:bool',
    /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)\n?$/,
    'yYnNtTfFoO',
  ],
  [
    'tag:yaml.org,2002:float',
    /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))\n?$/,
    '-+0123456789.',
  ],
  [
    'tag:yaml.org,2002:int',
    /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)\n?$/,
    '-+0123456789',
  ],
  ['tag:yaml.org,2002:merge', /^(?:<<)\n?$/, '<'],
  // `first` is `['~', 'n', 'N', '']`: the empty string is keyed by itself.
  ['tag:yaml.org,2002:null', /^(?:~|null|Null|NULL|)\n?$/, '~nN\0'],
  [
    'tag:yaml.org,2002:timestamp',
    /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)\n?$/,
    '0123456789',
  ],
  ['tag:yaml.org,2002:value', /^(?:=)\n?$/, '='],
  ['tag:yaml.org,2002:yaml', /^(?:!|&|\*)\n?$/, '!&*'],
];

type ResolverTable = ReadonlyMap<string, readonly (readonly [string, RegExp])[]>;

/**
 * The implicit resolvers by first character: first character -> the (tag, regexp) pairs in
 * registration order, the resolver's own entries and then `extra` appended after them.
 */
function resolverTable(extra: readonly ImplicitResolver[]): ResolverTable {
  const table = new Map<string, (readonly [string, RegExp])[]>();
  for (const [tag, regexp, first] of [...IMPLICIT, ...extra]) {
    for (const ch of first) {
      const key = ch === '\0' ? '' : ch;
      const list = table.get(key) ?? [];
      list.push([tag, regexp]);
      table.set(key, list);
    }
  }
  return table;
}

/** The resolver's own table, the one a plain safe dump resolves with. */
const RESOLVERS: ResolverTable = resolverTable([]);

const STR = 'tag:yaml.org,2002:str';

/** The tag a plain scalar `value` reads as. */
function resolvePlain(table: ResolverTable, value: string): string {
  const first = value === '' ? '' : (Array.from(value)[0] as string);
  for (const [tag, regexp] of table.get(first) ?? []) {
    if (regexp.test(value)) return tag;
  }
  return STR;
}

// ---------------------------------------------------------------------------------------
// The representer.

/** A float's text lowered, with `.nan`, `.inf` and `-.inf`, and a `.0` before an `e`. */
function floatText(value: number): string {
  if (Number.isNaN(value)) return '.nan';
  if (value === Infinity) return '.inf';
  if (value === -Infinity) return '-.inf';
  const text = floatString(value).toLowerCase();
  return !text.includes('.') && text.includes('e') ? text.replace('e', '.0e') : text;
}

/** An integer's digits. `String` spells an integral number from 1e21 up with an exponent. */
function intText(value: number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  return Math.abs(value) < 1e21 ? String(value) : BigInt(value).toString();
}

/** Base64 in lines of 76 characters, each ended by a line feed. */
function encodeBytes(data: Uint8Array): string {
  const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
  let out = '';
  for (let at = 0; at < text.length; at += 76) out += `${text.slice(at, at + 76)}\n`;
  return out;
}

/** The ISO text (a space between) of the UTC datetime at the instant a Date holds. */
function utcDatetimeText(value: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  let out = `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-`;
  out += `${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:`;
  out += pad(value.getUTCSeconds());
  const micro = value.getUTCMilliseconds() * 1000;
  if (micro !== 0) out += `.${pad(micro, 6)}`;
  return `${out}+00:00`;
}

/**
 * An object of no class: its prototype is null or SOME realm's `Object.prototype`. Compared
 * by shape rather than to this realm's, because `structuredClone` -- which `compose.ts`'s
 * deep copy is -- hands back objects of the realm Node's own globals live in, and under
 * jest that is not the realm the module runs in. The built-ins are asked of `util.types`
 * for the same reason, where `instanceof` would answer for this realm only.
 */
function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

class Representer {
  /** The node made for each object already represented, keyed by the object. */
  private readonly represented = new Map<object, YamlNode>();
  /** Which object the node being made stands for, when it may be aliased. */
  private aliasKey: object | null = null;

  constructor(private readonly options: SafeDumpOptions) {}

  representData(data: unknown): YamlNode {
    // Null, a string, a Uint8Array, a boolean and a number are never aliased -- a
    // `JsonFloat` included, which is an object here and stands for a float.
    this.aliasKey =
      data !== null &&
      typeof data === 'object' &&
      !types.isUint8Array(data) &&
      !(data instanceof JsonFloat)
        ? data
        : null;
    if (this.aliasKey !== null) {
      const seen = this.represented.get(this.aliasKey);
      if (seen !== undefined) return seen;
    }
    if (data === null || data === undefined) {
      return this.scalar('tag:yaml.org,2002:null', 'null');
    }
    // A `!!float` for a float a number cannot say is one: config.yaml's `ratio: 3.0`
    // and a `3.0:` key were rewritten `ratio: 3` and `3:`, where the file must keep what it
    // held.
    if (data instanceof JsonFloat) {
      return this.scalar('tag:yaml.org,2002:float', floatText(data.value));
    }
    switch (typeof data) {
      case 'string':
        return this.scalar(STR, data);
      case 'boolean':
        return this.scalar('tag:yaml.org,2002:bool', data ? 'true' : 'false');
      case 'bigint':
        return this.scalar('tag:yaml.org,2002:int', intText(data));
      case 'number':
        return Number.isInteger(data) && !Object.is(data, -0)
          ? this.scalar('tag:yaml.org,2002:int', intText(data))
          : this.scalar('tag:yaml.org,2002:float', floatText(data));
      default:
        break;
    }
    if (types.isUint8Array(data)) {
      return this.scalar('tag:yaml.org,2002:binary', encodeBytes(data), '|');
    }
    if (types.isDate(data)) {
      const text = this.options.dateText?.(data) ?? utcDatetimeText(data);
      return this.scalar('tag:yaml.org,2002:timestamp', text);
    }
    if (Array.isArray(data)) return this.sequence('tag:yaml.org,2002:seq', data as unknown[]);
    if (types.isSet(data)) {
      // A `!!set`: a mapping of each member to null, in the order the set holds them.
      return this.mapping(
        'tag:yaml.org,2002:set',
        [...(data as Set<unknown>)].map((member) => [member, null]),
      );
    }
    if (types.isMap(data)) {
      return this.mapping('tag:yaml.org,2002:map', [...(data as Map<unknown, unknown>)]);
    }
    if (typeof data === 'object' && isPlainObject(data)) {
      return this.mapping(
        'tag:yaml.org,2002:map',
        Object.keys(data).map((key) => [key, data[key]]),
      );
    }
    // Anything else cannot be represented.
    throw yamlError('RepresenterError', `cannot represent an object: ${String(data)}`);
  }

  private scalar(tag: string, value: string, style: Style = null): ScalarNode {
    const node: ScalarNode = { kind: 'scalar', tag, value, style };
    if (this.aliasKey !== null) this.represented.set(this.aliasKey, node);
    return node;
  }

  private sequence(tag: string, items: readonly unknown[]): SequenceNode {
    const node: SequenceNode = { kind: 'sequence', tag, value: [], flowStyle: false };
    if (this.aliasKey !== null) this.represented.set(this.aliasKey, node);
    for (const item of items) node.value.push(this.representData(item));
    // Block style decides, whatever the best style found would be.
    return node;
  }

  private mapping(tag: string, pairs: readonly (readonly [unknown, unknown])[]): MappingNode {
    const node: MappingNode = { kind: 'mapping', tag, value: [], flowStyle: false };
    if (this.aliasKey !== null) this.represented.set(this.aliasKey, node);
    for (const [key, value] of pairs) {
      // The package left a key whose value is `undefined` out, as JSON does; so does this.
      if (value === undefined) continue;
      const keyNode = this.representData(key);
      const valueNode = this.representData(value);
      node.value.push([keyNode, valueNode]);
    }
    return node;
  }
}

// ---------------------------------------------------------------------------------------
// The serializer.

class Serializer {
  private readonly anchors = new Map<YamlNode, string | null>();
  private readonly serialized = new Set<YamlNode>();
  private lastAnchorId = 0;

  constructor(
    private readonly emit: (event: YamlEvent) => void,
    private readonly resolvers: ResolverTable,
  ) {}

  serialize(node: YamlNode): void {
    this.emit({ type: 'DocumentStart', explicit: false });
    this.anchorNode(node);
    this.serializeNode(node);
    this.emit({ type: 'DocumentEnd', explicit: false });
  }

  private anchorNode(node: YamlNode): void {
    if (this.anchors.has(node)) {
      if (this.anchors.get(node) === null) {
        this.lastAnchorId += 1;
        // An anchor is `id` and three digits: `id001`.
        this.anchors.set(node, `id${String(this.lastAnchorId).padStart(3, '0')}`);
      }
      return;
    }
    this.anchors.set(node, null);
    if (node.kind === 'sequence') {
      for (const item of node.value) this.anchorNode(item);
    } else if (node.kind === 'mapping') {
      for (const [key, value] of node.value) {
        this.anchorNode(key);
        this.anchorNode(value);
      }
    }
  }

  private serializeNode(node: YamlNode): void {
    const alias = this.anchors.get(node) ?? null;
    if (this.serialized.has(node)) {
      this.emit({ type: 'Alias', anchor: alias });
      return;
    }
    this.serialized.add(node);
    if (node.kind === 'scalar') {
      const implicit: [boolean, boolean] = [
        node.tag === resolvePlain(this.resolvers, node.value),
        node.tag === STR,
      ];
      this.emit({
        type: 'Scalar',
        anchor: alias,
        tag: node.tag,
        implicit,
        value: node.value,
        style: node.style,
      });
    } else if (node.kind === 'sequence') {
      this.emit({
        type: 'SequenceStart',
        anchor: alias,
        tag: node.tag,
        implicit: node.tag === 'tag:yaml.org,2002:seq',
        flowStyle: node.flowStyle,
      });
      for (const item of node.value) this.serializeNode(item);
      this.emit({ type: 'SequenceEnd' });
    } else {
      this.emit({
        type: 'MappingStart',
        anchor: alias,
        tag: node.tag,
        implicit: node.tag === 'tag:yaml.org,2002:map',
        flowStyle: node.flowStyle,
      });
      for (const [key, value] of node.value) {
        this.serializeNode(key);
        this.serializeNode(value);
      }
      this.emit({ type: 'MappingEnd' });
    }
  }
}

// ---------------------------------------------------------------------------------------
// The emitter.

interface ScalarAnalysis {
  readonly scalar: string;
  readonly empty: boolean;
  readonly multiline: boolean;
  readonly allowFlowPlain: boolean;
  readonly allowBlockPlain: boolean;
  readonly allowSingleQuoted: boolean;
  readonly allowDoubleQuoted: boolean;
  readonly allowBlock: boolean;
}

/** The four line breaks the emitter knows: LF, NEL, U+2028 and U+2029. */
const BREAKS = '\n\u0085\u2028\u2029';
/** What counts as whitespace around an indicator: NUL, space, tab, CR and the four breaks. */
const WHITESPACE = '\0 \t\r\n\u0085\u2028\u2029';

const ESCAPE_REPLACEMENTS: ReadonlyMap<string, string> = new Map([
  ['\0', '0'],
  ['\u0007', 'a'],
  ['\b', 'b'],
  ['\t', 't'],
  ['\n', 'n'],
  ['\u000b', 'v'],
  ['\f', 'f'],
  ['\r', 'r'],
  ['\u001b', 'e'],
  ['"', '"'],
  ['\\', '\\'],
  ['\u0085', 'N'],
  ['\u00a0', '_'],
  ['\u2028', 'L'],
  ['\u2029', 'P'],
]);

const DEFAULT_TAG_PREFIXES: ReadonlyMap<string, string> = new Map([
  ['!', '!'],
  ['tag:yaml.org,2002:', '!!'],
]);

function code(ch: string): number {
  return ch.codePointAt(0) ?? 0;
}

function hex(value: number, width: number): string {
  return value.toString(16).toUpperCase().padStart(width, '0');
}

/** A tag character the emitter writes as it is, not percent-escaped. */
function tagSafe(ch: string): boolean {
  return /^[0-9A-Za-z]$/.test(ch) || "-;/?:@&=+$,_.~*'()[]".includes(ch);
}

class Emitter {
  private readonly states: (() => void)[] = [];
  private state: () => void = () => this.expectStreamStart();
  private readonly events: YamlEvent[] = [];
  private event: YamlEvent | null = null;
  private readonly indents: (number | null)[] = [];
  private indent: number | null = null;
  private flowLevel = 0;
  private rootContext = false;
  private sequenceContext = false;
  private mappingContext = false;
  private simpleKeyContext = false;
  private column = 0;
  private whitespace = true;
  private indention = true;
  private openEnded = false;
  private readonly canonical: boolean = false;
  private readonly allowUnicode: boolean = false;
  private readonly bestIndent = 2;
  private readonly bestWidth = 80;
  private readonly bestLineBreak = '\n';
  private tagPrefixes: Map<string, string> = new Map();
  private preparedAnchor: string | null = null;
  private preparedTag: string | null = null;
  private analysis: ScalarAnalysis | null = null;
  private style: Style = null;

  constructor(private readonly stream: string[]) {}

  emit(event: YamlEvent): void {
    this.events.push(event);
    while (!this.needMoreEvents()) {
      this.event = this.events.shift() ?? null;
      this.state();
      this.event = null;
    }
  }

  private current(): YamlEvent {
    if (this.event === null) throw yamlError('EmitterError', 'no current event');
    return this.event;
  }

  private needMoreEvents(): boolean {
    const [event] = this.events;
    if (event === undefined) return true;
    if (event.type === 'DocumentStart') return this.needEvents(1);
    if (event.type === 'SequenceStart') return this.needEvents(2);
    if (event.type === 'MappingStart') return this.needEvents(3);
    return false;
  }

  private needEvents(count: number): boolean {
    let level = 0;
    for (const event of this.events.slice(1)) {
      if (['DocumentStart', 'SequenceStart', 'MappingStart'].includes(event.type)) level += 1;
      else if (['DocumentEnd', 'SequenceEnd', 'MappingEnd'].includes(event.type)) level -= 1;
      else if (event.type === 'StreamEnd') level = -1;
      if (level < 0) return false;
    }
    return this.events.length < count + 1;
  }

  private increaseIndent(flow = false, indentless = false): void {
    this.indents.push(this.indent);
    if (this.indent === null) this.indent = flow ? this.bestIndent : 0;
    else if (!indentless) this.indent += this.bestIndent;
  }

  private popState(): void {
    const next = this.states.pop();
    if (next === undefined) throw yamlError('EmitterError', 'the state stack is empty');
    this.state = next;
  }

  private popIndent(): void {
    this.indent = this.indents.pop() ?? null;
  }

  // Stream handlers.

  private expectStreamStart(): void {
    if (this.current().type !== 'StreamStart') {
      throw yamlError('EmitterError', 'expected StreamStartEvent');
    }
    // A stream start writes a BOM only for a UTF-16 encoding; there is none.
    this.state = () => this.expectDocumentStart(true);
  }

  private expectNothing(): void {
    throw yamlError('EmitterError', 'expected nothing');
  }

  // Document handlers.

  private expectDocumentStart(first = false): void {
    const event = this.current();
    if (event.type === 'DocumentStart') {
      // No version and no tag directives: the dump is given neither.
      this.tagPrefixes = new Map(DEFAULT_TAG_PREFIXES);
      const implicit = first && !event.explicit && !this.canonical && !this.checkEmptyDocument();
      if (!implicit) {
        this.writeIndent();
        this.writeIndicator('---', true);
        if (this.canonical) this.writeIndent();
      }
      this.state = () => this.expectDocumentRoot();
    } else if (event.type === 'StreamEnd') {
      if (this.openEnded) {
        this.writeIndicator('...', true);
        this.writeIndent();
      }
      this.state = () => this.expectNothing();
    } else {
      throw yamlError('EmitterError', 'expected DocumentStartEvent');
    }
  }

  private expectDocumentEnd(): void {
    const event = this.current();
    if (event.type !== 'DocumentEnd') {
      throw yamlError('EmitterError', 'expected DocumentEndEvent');
    }
    this.writeIndent();
    if (event.explicit) {
      this.writeIndicator('...', true);
      this.writeIndent();
    }
    this.state = () => this.expectDocumentStart();
  }

  private expectDocumentRoot(): void {
    this.states.push(() => this.expectDocumentEnd());
    this.expectNode(true);
  }

  // Node handlers.

  private expectNode(root = false, sequence = false, mapping = false, simpleKey = false): void {
    this.rootContext = root;
    this.sequenceContext = sequence;
    this.mappingContext = mapping;
    this.simpleKeyContext = simpleKey;
    const event = this.current();
    if (event.type === 'Alias') {
      this.expectAlias();
    } else if (
      event.type === 'Scalar' ||
      event.type === 'SequenceStart' ||
      event.type === 'MappingStart'
    ) {
      this.processAnchor('&');
      this.processTag();
      if (event.type === 'Scalar') {
        this.expectScalar();
      } else if (event.type === 'SequenceStart') {
        if (this.flowLevel || this.canonical || event.flowStyle || this.checkEmptySequence()) {
          this.expectFlowSequence();
        } else {
          this.expectBlockSequence();
        }
      } else if (this.flowLevel || this.canonical || event.flowStyle || this.checkEmptyMapping()) {
        this.expectFlowMapping();
      } else {
        this.expectBlockMapping();
      }
    } else {
      throw yamlError('EmitterError', 'expected NodeEvent');
    }
  }

  private expectAlias(): void {
    const event = this.current();
    if (event.type !== 'Alias' || event.anchor === null) {
      throw yamlError('EmitterError', 'anchor is not specified for alias');
    }
    this.processAnchor('*');
    this.popState();
  }

  private expectScalar(): void {
    this.increaseIndent(true);
    this.processScalar();
    this.popIndent();
    this.popState();
  }

  // Flow sequence handlers.

  private expectFlowSequence(): void {
    this.writeIndicator('[', true, true);
    this.flowLevel += 1;
    this.increaseIndent(true);
    this.state = () => this.expectFirstFlowSequenceItem();
  }

  private expectFirstFlowSequenceItem(): void {
    if (this.current().type === 'SequenceEnd') {
      this.popIndent();
      this.flowLevel -= 1;
      this.writeIndicator(']', false);
      this.popState();
    } else {
      if (this.canonical || this.column > this.bestWidth) this.writeIndent();
      this.states.push(() => this.expectFlowSequenceItem());
      this.expectNode(false, true);
    }
  }

  private expectFlowSequenceItem(): void {
    if (this.current().type === 'SequenceEnd') {
      this.popIndent();
      this.flowLevel -= 1;
      if (this.canonical) {
        this.writeIndicator(',', false);
        this.writeIndent();
      }
      this.writeIndicator(']', false);
      this.popState();
    } else {
      this.writeIndicator(',', false);
      if (this.canonical || this.column > this.bestWidth) this.writeIndent();
      this.states.push(() => this.expectFlowSequenceItem());
      this.expectNode(false, true);
    }
  }

  // Flow mapping handlers.

  private expectFlowMapping(): void {
    this.writeIndicator('{', true, true);
    this.flowLevel += 1;
    this.increaseIndent(true);
    this.state = () => this.expectFirstFlowMappingKey();
  }

  private expectFirstFlowMappingKey(): void {
    if (this.current().type === 'MappingEnd') {
      this.popIndent();
      this.flowLevel -= 1;
      this.writeIndicator('}', false);
      this.popState();
    } else {
      if (this.canonical || this.column > this.bestWidth) this.writeIndent();
      this.flowMappingKey();
    }
  }

  private expectFlowMappingKey(): void {
    if (this.current().type === 'MappingEnd') {
      this.popIndent();
      this.flowLevel -= 1;
      if (this.canonical) {
        this.writeIndicator(',', false);
        this.writeIndent();
      }
      this.writeIndicator('}', false);
      this.popState();
    } else {
      this.writeIndicator(',', false);
      if (this.canonical || this.column > this.bestWidth) this.writeIndent();
      this.flowMappingKey();
    }
  }

  /** The shared tail of the two flow-mapping key handlers. */
  private flowMappingKey(): void {
    if (!this.canonical && this.checkSimpleKey()) {
      this.states.push(() => this.expectFlowMappingSimpleValue());
      this.expectNode(false, false, true, true);
    } else {
      this.writeIndicator('?', true);
      this.states.push(() => this.expectFlowMappingValue());
      this.expectNode(false, false, true);
    }
  }

  private expectFlowMappingSimpleValue(): void {
    this.writeIndicator(':', false);
    this.states.push(() => this.expectFlowMappingKey());
    this.expectNode(false, false, true);
  }

  private expectFlowMappingValue(): void {
    if (this.canonical || this.column > this.bestWidth) this.writeIndent();
    this.writeIndicator(':', true);
    this.states.push(() => this.expectFlowMappingKey());
    this.expectNode(false, false, true);
  }

  // Block sequence handlers.

  private expectBlockSequence(): void {
    const indentless = this.mappingContext && !this.indention;
    this.increaseIndent(false, indentless);
    this.state = () => this.expectBlockSequenceItem(true);
  }

  private expectBlockSequenceItem(first = false): void {
    if (!first && this.current().type === 'SequenceEnd') {
      this.popIndent();
      this.popState();
    } else {
      this.writeIndent();
      this.writeIndicator('-', true, false, true);
      this.states.push(() => this.expectBlockSequenceItem());
      this.expectNode(false, true);
    }
  }

  // Block mapping handlers.

  private expectBlockMapping(): void {
    this.increaseIndent(false);
    this.state = () => this.expectBlockMappingKey(true);
  }

  private expectBlockMappingKey(first = false): void {
    if (!first && this.current().type === 'MappingEnd') {
      this.popIndent();
      this.popState();
    } else {
      this.writeIndent();
      if (this.checkSimpleKey()) {
        this.states.push(() => this.expectBlockMappingSimpleValue());
        this.expectNode(false, false, true, true);
      } else {
        this.writeIndicator('?', true, false, true);
        this.states.push(() => this.expectBlockMappingValue());
        this.expectNode(false, false, true);
      }
    }
  }

  private expectBlockMappingSimpleValue(): void {
    this.writeIndicator(':', false);
    this.states.push(() => this.expectBlockMappingKey());
    this.expectNode(false, false, true);
  }

  private expectBlockMappingValue(): void {
    this.writeIndent();
    this.writeIndicator(':', true, false, true);
    this.states.push(() => this.expectBlockMappingKey());
    this.expectNode(false, false, true);
  }

  // Checkers.

  private checkEmptySequence(): boolean {
    return this.current().type === 'SequenceStart' && this.events[0]?.type === 'SequenceEnd';
  }

  private checkEmptyMapping(): boolean {
    return this.current().type === 'MappingStart' && this.events[0]?.type === 'MappingEnd';
  }

  private checkEmptyDocument(): boolean {
    const [next] = this.events;
    if (this.current().type !== 'DocumentStart' || next === undefined) return false;
    // The scalar's implicit flag is a pair, which always counts as set, so it is not tested.
    return next.type === 'Scalar' && next.anchor === null && next.tag === null && next.value === '';
  }

  private checkSimpleKey(): boolean {
    const event = this.current();
    let length = 0;
    if (
      (event.type === 'Alias' ||
        event.type === 'Scalar' ||
        event.type === 'SequenceStart' ||
        event.type === 'MappingStart') &&
      event.anchor !== null
    ) {
      this.preparedAnchor ??= this.prepareAnchor(event.anchor);
      length += Array.from(this.preparedAnchor).length;
    }
    if (
      (event.type === 'Scalar' ||
        event.type === 'SequenceStart' ||
        event.type === 'MappingStart') &&
      event.tag !== null
    ) {
      this.preparedTag ??= this.prepareTag(event.tag);
      length += Array.from(this.preparedTag).length;
    }
    let analysis: ScalarAnalysis | null = null;
    if (event.type === 'Scalar') {
      this.analysis ??= this.analyzeScalar(event.value);
      analysis = this.analysis;
      length += Array.from(analysis.scalar).length;
    }
    return (
      length < 128 &&
      (event.type === 'Alias' ||
        (analysis !== null && !analysis.empty && !analysis.multiline) ||
        this.checkEmptySequence() ||
        this.checkEmptyMapping())
    );
  }

  // Anchor, Tag, and Scalar processors.

  private processAnchor(indicator: string): void {
    const event = this.current();
    const anchor = 'anchor' in event ? event.anchor : null;
    if (anchor === null) {
      this.preparedAnchor = null;
      return;
    }
    this.preparedAnchor ??= this.prepareAnchor(anchor);
    if (this.preparedAnchor) this.writeIndicator(indicator + this.preparedAnchor, true);
    this.preparedAnchor = null;
  }

  private processTag(): void {
    const event = this.current();
    let tag = 'tag' in event ? event.tag : null;
    if (event.type === 'Scalar') {
      this.style ??= this.chooseScalarStyle();
      if (
        (!this.canonical || tag === null) &&
        ((this.style === '' && event.implicit[0]) || (this.style !== '' && event.implicit[1]))
      ) {
        this.preparedTag = null;
        return;
      }
      if (event.implicit[0] && tag === null) {
        tag = '!';
        this.preparedTag = null;
      }
    } else if (event.type === 'SequenceStart' || event.type === 'MappingStart') {
      if ((!this.canonical || tag === null) && event.implicit) {
        this.preparedTag = null;
        return;
      }
    }
    if (tag === null) throw yamlError('EmitterError', 'tag is not specified');
    this.preparedTag ??= this.prepareTag(tag);
    if (this.preparedTag) this.writeIndicator(this.preparedTag, true);
    this.preparedTag = null;
  }

  private chooseScalarStyle(): Style {
    const event = this.current();
    if (event.type !== 'Scalar') throw yamlError('EmitterError', 'expected ScalarEvent');
    this.analysis ??= this.analyzeScalar(event.value);
    const analysis = this.analysis;
    if (event.style === '"' || this.canonical) return '"';
    if (!event.style && event.implicit[0]) {
      if (
        !(this.simpleKeyContext && (analysis.empty || analysis.multiline)) &&
        ((this.flowLevel && analysis.allowFlowPlain) ||
          (!this.flowLevel && analysis.allowBlockPlain))
      ) {
        return '';
      }
    }
    if (event.style && '|>'.includes(event.style)) {
      if (!this.flowLevel && !this.simpleKeyContext && analysis.allowBlock) return event.style;
    }
    if (!event.style || event.style === "'") {
      if (analysis.allowSingleQuoted && !(this.simpleKeyContext && analysis.multiline)) {
        return "'";
      }
    }
    return '"';
  }

  private processScalar(): void {
    const event = this.current();
    if (event.type !== 'Scalar') throw yamlError('EmitterError', 'expected ScalarEvent');
    this.analysis ??= this.analyzeScalar(event.value);
    this.style ??= this.chooseScalarStyle();
    const split = !this.simpleKeyContext;
    const text = this.analysis.scalar;
    if (this.style === '"') this.writeDoubleQuoted(text, split);
    else if (this.style === "'") this.writeSingleQuoted(text, split);
    else if (this.style === '>') this.writeFolded(text);
    else if (this.style === '|') this.writeLiteral(text);
    else this.writePlain(text, split);
    this.analysis = null;
    this.style = null;
  }

  // Analyzers.

  private prepareTag(tag: string): string {
    if (!tag) throw yamlError('EmitterError', 'tag must not be empty');
    if (tag === '!') return tag;
    let handle: string | null = null;
    let suffix = tag;
    const prefixes = [...this.tagPrefixes.keys()].sort();
    for (const prefix of prefixes) {
      if (tag.startsWith(prefix) && (prefix === '!' || prefix.length < tag.length)) {
        handle = this.tagPrefixes.get(prefix) ?? null;
        suffix = tag.slice(prefix.length);
      }
    }
    let text = '';
    for (const ch of suffix) {
      if (tagSafe(ch) || (ch === '!' && handle !== '!')) {
        text += ch;
      } else {
        for (const byte of Buffer.from(ch, 'utf8')) text += `%${hex(byte, 2)}`;
      }
    }
    return handle ? `${handle}${text}` : `!<${text}>`;
  }

  private prepareAnchor(anchor: string): string {
    if (!anchor) throw yamlError('EmitterError', 'anchor must not be empty');
    for (const ch of anchor) {
      if (!/^[0-9A-Za-z_-]$/.test(ch)) {
        throw yamlError('EmitterError', `invalid character in the anchor: ${anchor}`);
      }
    }
    return anchor;
  }

  private analyzeScalar(scalar: string): ScalarAnalysis {
    // Empty scalar is a special case.
    if (!scalar) {
      return {
        scalar,
        empty: true,
        multiline: false,
        allowFlowPlain: false,
        allowBlockPlain: true,
        allowSingleQuoted: true,
        allowDoubleQuoted: true,
        allowBlock: false,
      };
    }
    const text = Array.from(scalar);
    const length = text.length;

    // Indicators and special characters.
    let blockIndicators = false;
    let flowIndicators = false;
    let lineBreaks = false;
    let specialCharacters = false;

    // Important whitespace combinations.
    let leadingSpace = false;
    let leadingBreak = false;
    let trailingSpace = false;
    let trailingBreak = false;
    let breakSpace = false;
    let spaceBreak = false;

    // Check document indicators.
    if (scalar.startsWith('---') || scalar.startsWith('...')) {
      blockIndicators = true;
      flowIndicators = true;
    }

    // First character or preceded by a whitespace.
    let precededByWhitespace = true;

    // Last character or followed by a whitespace.
    let followedByWhitespace = length === 1 || WHITESPACE.includes(text[1] as string);

    // The previous character is a space.
    let previousSpace = false;

    // The previous character is a break.
    let previousBreak = false;

    for (let index = 0; index < length;) {
      const ch = text[index] as string;
      const point = code(ch);

      // Check for indicators.
      if (index === 0) {
        // Leading indicators are special characters.
        if ('#,[]{}&*!|>\'"%@`'.includes(ch)) {
          flowIndicators = true;
          blockIndicators = true;
        }
        if ('?:'.includes(ch)) {
          flowIndicators = true;
          if (followedByWhitespace) blockIndicators = true;
        }
        if (ch === '-' && followedByWhitespace) {
          flowIndicators = true;
          blockIndicators = true;
        }
      } else {
        // Some indicators cannot appear within a scalar as well.
        if (',?[]{}'.includes(ch)) flowIndicators = true;
        if (ch === ':') {
          flowIndicators = true;
          if (followedByWhitespace) blockIndicators = true;
        }
        if (ch === '#' && precededByWhitespace) {
          flowIndicators = true;
          blockIndicators = true;
        }
      }

      // Check for line breaks, special, and unicode characters.
      if (BREAKS.includes(ch)) lineBreaks = true;
      if (!(ch === '\n' || (point >= 0x20 && point <= 0x7e))) {
        const unicode =
          (point === 0x85 ||
            (point >= 0xa0 && point <= 0xd7ff) ||
            (point >= 0xe000 && point <= 0xfffd) ||
            (point >= 0x10000 && point < 0x10ffff)) &&
          point !== 0xfeff;
        // With non-ASCII escaped, a printable non-ASCII character is as special as a
        // control character.
        if (!unicode || !this.allowUnicode) specialCharacters = true;
      }

      // Detect important whitespace combinations.
      if (ch === ' ') {
        if (index === 0) leadingSpace = true;
        if (index === length - 1) trailingSpace = true;
        if (previousBreak) breakSpace = true;
        previousSpace = true;
        previousBreak = false;
      } else if (BREAKS.includes(ch)) {
        if (index === 0) leadingBreak = true;
        if (index === length - 1) trailingBreak = true;
        if (previousSpace) spaceBreak = true;
        previousSpace = false;
        previousBreak = true;
      } else {
        previousSpace = false;
        previousBreak = false;
      }

      // Prepare for the next character.
      index += 1;
      precededByWhitespace = WHITESPACE.includes(ch);
      followedByWhitespace = index + 1 >= length || WHITESPACE.includes(text[index + 1] as string);
    }

    // Let's decide what styles are allowed.
    let allowFlowPlain = true;
    let allowBlockPlain = true;
    let allowSingleQuoted = true;
    const allowDoubleQuoted = true;
    let allowBlock = true;

    // Leading and trailing whitespaces are bad for plain scalars.
    if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) {
      allowFlowPlain = allowBlockPlain = false;
    }
    // We do not permit trailing spaces for block scalars.
    if (trailingSpace) allowBlock = false;
    // Spaces at the beginning of a new line are only acceptable for block scalars.
    if (breakSpace) allowFlowPlain = allowBlockPlain = allowSingleQuoted = false;
    // Spaces followed by breaks, as well as special character are only allowed for double
    // quoted scalars.
    if (spaceBreak || specialCharacters) {
      allowFlowPlain = allowBlockPlain = allowSingleQuoted = allowBlock = false;
    }
    // Although the plain scalar writer supports breaks, we never emit multiline plain scalars.
    if (lineBreaks) allowFlowPlain = allowBlockPlain = false;
    // Flow indicators are forbidden for flow plain scalars.
    if (flowIndicators) allowFlowPlain = false;
    // Block indicators are forbidden for block plain scalars.
    if (blockIndicators) allowBlockPlain = false;

    return {
      scalar,
      empty: false,
      multiline: lineBreaks,
      allowFlowPlain,
      allowBlockPlain,
      allowSingleQuoted,
      allowDoubleQuoted,
      allowBlock,
    };
  }

  // Writers.

  private write(data: string): void {
    this.stream.push(data);
  }

  private writeIndicator(
    indicator: string,
    needWhitespace: boolean,
    whitespace = false,
    indention = false,
  ): void {
    const data = this.whitespace || !needWhitespace ? indicator : ` ${indicator}`;
    this.whitespace = whitespace;
    this.indention = this.indention && indention;
    this.column += Array.from(data).length;
    this.openEnded = false;
    this.write(data);
  }

  private writeIndent(): void {
    const indent = this.indent ?? 0;
    if (!this.indention || this.column > indent || (this.column === indent && !this.whitespace)) {
      this.writeLineBreak();
    }
    if (this.column < indent) {
      this.whitespace = true;
      this.write(' '.repeat(indent - this.column));
      this.column = indent;
    }
  }

  private writeLineBreak(data: string | null = null): void {
    this.whitespace = true;
    this.indention = true;
    this.column = 0;
    this.write(data ?? this.bestLineBreak);
  }

  /** The run from `start` to `end` written and counted, the step every writer repeats. */
  private writeRun(text: readonly string[], start: number, end: number): void {
    const data = text.slice(start, end).join('');
    this.column += end - start;
    this.write(data);
  }

  /** The line breaks from `start` to `end`, each written as itself or as the default break. */
  private writeBreaks(text: readonly string[], start: number, end: number): void {
    for (const br of text.slice(start, end)) this.writeLineBreak(br === '\n' ? null : br);
  }

  // Scalar streams.

  private writeSingleQuoted(scalar: string, split = true): void {
    const text = Array.from(scalar);
    this.writeIndicator("'", true);
    let spaces = false;
    let breaks = false;
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch = end < text.length ? (text[end] as string) : null;
      if (spaces) {
        if (ch === null || ch !== ' ') {
          if (
            start + 1 === end &&
            this.column > this.bestWidth &&
            split &&
            start !== 0 &&
            end !== text.length
          ) {
            this.writeIndent();
          } else {
            this.writeRun(text, start, end);
          }
          start = end;
        }
      } else if (breaks) {
        if (ch === null || !BREAKS.includes(ch)) {
          if (text[start] === '\n') this.writeLineBreak();
          this.writeBreaks(text, start, end);
          this.writeIndent();
          start = end;
        }
      } else if (ch === null || ` ${BREAKS}`.includes(ch) || ch === "'") {
        if (start < end) {
          this.writeRun(text, start, end);
          start = end;
        }
      }
      if (ch === "'") {
        this.column += 2;
        this.write("''");
        start = end + 1;
      }
      if (ch !== null) {
        spaces = ch === ' ';
        breaks = BREAKS.includes(ch);
      }
      end += 1;
    }
    this.writeIndicator("'", false);
  }

  private writeDoubleQuoted(scalar: string, split = true): void {
    const text = Array.from(scalar);
    this.writeIndicator('"', true);
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch = end < text.length ? (text[end] as string) : null;
      const point = ch === null ? 0 : code(ch);
      if (
        ch === null ||
        '"\\\u0085\u2028\u2029\ufeff'.includes(ch) ||
        !(
          (point >= 0x20 && point <= 0x7e) ||
          (this.allowUnicode &&
            ((point >= 0xa0 && point <= 0xd7ff) || (point >= 0xe000 && point <= 0xfffd)))
        )
      ) {
        if (start < end) {
          this.writeRun(text, start, end);
          start = end;
        }
        if (ch !== null) {
          const replacement = ESCAPE_REPLACEMENTS.get(ch);
          let data: string;
          if (replacement !== undefined) data = `\\${replacement}`;
          else if (point <= 0xff) data = `\\x${hex(point, 2)}`;
          else if (point <= 0xffff) data = `\\u${hex(point, 4)}`;
          else data = `\\U${hex(point, 8)}`;
          this.column += data.length;
          this.write(data);
          start = end + 1;
        }
      }
      if (
        end > 0 &&
        end < text.length - 1 &&
        (ch === ' ' || start >= end) &&
        this.column + (end - start) > this.bestWidth &&
        split
      ) {
        const data = `${text.slice(start, end).join('')}\\`;
        const counted = end - start + 1;
        if (start < end) start = end;
        this.column += counted;
        this.write(data);
        this.writeIndent();
        this.whitespace = false;
        this.indention = false;
        if (text[start] === ' ') {
          this.column += 1;
          this.write('\\');
        }
      }
      end += 1;
    }
    this.writeIndicator('"', false);
  }

  private determineBlockHints(text: readonly string[]): string {
    let hints = '';
    if (text.length > 0) {
      if (` ${BREAKS}`.includes(text[0] as string)) hints += String(this.bestIndent);
      if (!BREAKS.includes(text[text.length - 1] as string)) hints += '-';
      else if (text.length === 1 || BREAKS.includes(text[text.length - 2] as string)) hints += '+';
    }
    return hints;
  }

  private writeFolded(scalar: string): void {
    const text = Array.from(scalar);
    const hints = this.determineBlockHints(text);
    this.writeIndicator(`>${hints}`, true);
    if (hints.endsWith('+')) this.openEnded = true;
    this.writeLineBreak();
    let leadingSpace = true;
    let spaces = false;
    let breaks = true;
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch = end < text.length ? (text[end] as string) : null;
      if (breaks) {
        if (ch === null || !BREAKS.includes(ch)) {
          if (!leadingSpace && ch !== null && ch !== ' ' && text[start] === '\n') {
            this.writeLineBreak();
          }
          leadingSpace = ch === ' ';
          this.writeBreaks(text, start, end);
          if (ch !== null) this.writeIndent();
          start = end;
        }
      } else if (spaces) {
        if (ch !== ' ') {
          if (start + 1 === end && this.column > this.bestWidth) this.writeIndent();
          else this.writeRun(text, start, end);
          start = end;
        }
      } else if (ch === null || ` ${BREAKS}`.includes(ch)) {
        this.writeRun(text, start, end);
        if (ch === null) this.writeLineBreak();
        start = end;
      }
      if (ch !== null) {
        breaks = BREAKS.includes(ch);
        spaces = ch === ' ';
      }
      end += 1;
    }
  }

  private writeLiteral(scalar: string): void {
    const text = Array.from(scalar);
    const hints = this.determineBlockHints(text);
    this.writeIndicator(`|${hints}`, true);
    if (hints.endsWith('+')) this.openEnded = true;
    this.writeLineBreak();
    let breaks = true;
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch = end < text.length ? (text[end] as string) : null;
      if (breaks) {
        if (ch === null || !BREAKS.includes(ch)) {
          this.writeBreaks(text, start, end);
          if (ch !== null) this.writeIndent();
          start = end;
        }
      } else if (ch === null || BREAKS.includes(ch)) {
        // A literal scalar's run is written without counting it: the line break after it
        // resets the column.
        this.write(text.slice(start, end).join(''));
        if (ch === null) this.writeLineBreak();
        start = end;
      }
      if (ch !== null) breaks = BREAKS.includes(ch);
      end += 1;
    }
  }

  private writePlain(scalar: string, split = true): void {
    if (this.rootContext) this.openEnded = true;
    if (!scalar) return;
    const text = Array.from(scalar);
    if (!this.whitespace) {
      this.column += 1;
      this.write(' ');
    }
    this.whitespace = false;
    this.indention = false;
    let spaces = false;
    let breaks = false;
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch = end < text.length ? (text[end] as string) : null;
      if (spaces) {
        if (ch !== ' ') {
          if (start + 1 === end && this.column > this.bestWidth && split) {
            this.writeIndent();
            this.whitespace = false;
            this.indention = false;
          } else {
            this.writeRun(text, start, end);
          }
          start = end;
        }
      } else if (breaks) {
        if (ch === null || !BREAKS.includes(ch)) {
          if (text[start] === '\n') this.writeLineBreak();
          this.writeBreaks(text, start, end);
          this.writeIndent();
          this.whitespace = false;
          this.indention = false;
          start = end;
        }
      } else if (ch === null || ` ${BREAKS}`.includes(ch)) {
        this.writeRun(text, start, end);
        start = end;
      }
      if (ch !== null) {
        spaces = ch === ' ';
        breaks = BREAKS.includes(ch);
      }
      end += 1;
    }
  }
}

/**
 * `data` as one YAML document, in block style with its keys in their own order; given
 * `implicitResolvers`, with those consulted after the resolver's own.
 */
export function safeDump(data: unknown, options: SafeDumpOptions = {}): string {
  const stream: string[] = [];
  const emitter = new Emitter(stream);
  emitter.emit({ type: 'StreamStart' });
  const node = new Representer(options).representData(data);
  const extra = options.implicitResolvers ?? [];
  new Serializer(
    (event) => {
      emitter.emit(event);
    },
    extra.length === 0 ? RESOLVERS : resolverTable(extra),
  ).serialize(node);
  emitter.emit({ type: 'StreamEnd' });
  return stream.join('');
}
