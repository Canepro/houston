/** The CLI's complete declarative surface. */

export type ValueKind = 'boolean' | 'string' | 'integer' | 'float';

export interface ArgumentSpec {
  readonly name: string;
  readonly value: Exclude<ValueKind, 'boolean'>;
  readonly required: boolean;
  readonly defaultValue?: string | number | null;
  readonly description: string;
}

export interface OptionSpec {
  /** Stable handler key; deliberately independent of Commander's camel-casing. */
  readonly key: string;
  /** Frozen logical spelling. Paired booleans remain one published flag. */
  readonly long: string;
  readonly short?: string;
  readonly value: ValueKind;
  readonly required: boolean;
  readonly repeatable: boolean;
  readonly defaultValue?: string | number | boolean | null;
  readonly description: string;
  readonly hidden: boolean;
  readonly negatablePair: boolean;
  /**
   * The short spelling was DECLARED first (`"-n", "--lines"`). A usage error names an option
   * by its declarations in order -- `'-n' / '--lines'` -- so the order is surface.
   */
  readonly shortFirst?: true;
}

export interface JsonSpec {
  readonly mode: 'none' | 'flag' | 'always';
  readonly schema?: string;
  /** A positional argument whose accepted values select exact success schemas. */
  readonly variants?: {
    readonly argument: string;
    readonly byValue: Readonly<Record<string, string>>;
  };
  /**
   * Success schemas a handler selects by naming one in its payload's own `schema`. The
   * envelope then advertises that schema instead of `schema`, which stays the default.
   */
  readonly payloadSchemas?: readonly string[];
  readonly streams: boolean;
  readonly option?: { readonly index: number; readonly description: string };
}

export interface CommandSpec {
  readonly id: string;
  readonly path: string;
  readonly description: string;
  readonly arguments: readonly ArgumentSpec[];
  readonly options: readonly OptionSpec[];
  readonly json: JsonSpec;
}

/** Identity function: literals are checked without manufacturing a second table. */
export function defineCommand<const T extends CommandSpec>(spec: T): Readonly<T> {
  return Object.freeze(spec);
}
