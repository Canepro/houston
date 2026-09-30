/**
 * The toolchain decisions, pinned.
 *
 * Every assertion here pins a toolchain rule that has a cost attached, and each is the
 * kind of setting somebody relaxes in passing to make a build go green. Earlier releases'
 * suite already did this — it walked the source to prove `PHASES` is closed and pinned 40 `--help`
 * texts — so a configuration nobody checks would be the one unguarded surface in the tree.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(__dirname, '..');

function run(bin: string, args: string[]) {
  return spawnSync(bin, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runYarn(script: string) {
  return run('corepack', ['yarn', script]);
}

/** JSON with `//` comments — tsconfig.json is JSONC, which JSON.parse will not read. */
function readJsonc(file: string): Record<string, unknown> {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const stripped = text.replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(stripped) as Record<string, unknown>;
}

describe('module system', () => {
  // ESM's read-only live bindings re-introduce the exact import-cycle hazard this tree
  // holds at zero, for no benefit. An in-function `require()` resolves at CALL time, which
  // is what this package's 259 function-body imports do.
  it('emits CommonJS, never ESM', () => {
    const tsconfig = readJsonc('tsconfig.json');
    const options = tsconfig.compilerOptions as Record<string, unknown>;
    expect(options.module).toBe('commonjs');

    const pkg = readJsonc('package.json');
    expect(pkg.type).toBeUndefined();
  });
});

describe('type checking', () => {
  const options = readJsonc('tsconfig.json').compilerOptions as Record<string, unknown>;

  it.each([
    ['strict', 'the baseline'],
    ['noUncheckedIndexedAccess', 'a missing compose service is possibly-undefined, not undefined'],
    [
      'exactOptionalPropertyTypes',
      'an absent key and a key set to undefined are different documents',
    ],
  ])('has %s on (%s)', (flag) => {
    expect(options[flag]).toBe(true);
  });

  it('type-checks the tests as well as the source, and emits the source alone', () => {
    // A suite the type checker never reads is free to assert against a shape that does
    // not exist, so the GATE reads test/ as well as src/. The EMIT reads src/ and nothing
    // else: every spec and setup file lives under test/, so none can reach dist/.
    const include = readJsonc('tsconfig.json').include as string[];
    expect(include).toEqual(expect.arrayContaining(['src/**/*.ts', 'test/**/*.ts']));
    const build = readJsonc('tsconfig.build.json');
    expect(build.include).toEqual(['src/**/*.ts']);
    expect((build.compilerOptions as Record<string, unknown>).rootDir).toBe('src');
  });
});

describe('build', () => {
  it('is `tsc` emit with no bundler', () => {
    const pkg = readJsonc('package.json');
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts.build).toMatch(/^tsc /);

    // A bundler rewrites the `data/` lookup behind `dataPath()`. `versions`
    // then falls back to the live endpoint and presets report "not found" — at runtime,
    // in production, with a green build.
    const deps = {
      ...(pkg.dependencies as Record<string, string>),
      ...(pkg.devDependencies as Record<string, string>),
    };
    for (const bundler of [
      'webpack',
      'rollup',
      'esbuild',
      'vite',
      'parcel',
      'tsup',
      'browserify',
    ]) {
      expect(Object.keys(deps)).not.toContain(bundler);
    }
  });

  it('pins TypeScript to the 5.9 series, not 7', () => {
    // TS 7 has no stable compiler API until 7.1 and breaks both `typescript-eslint` and
    // `dependency-cruiser` — the latter by SILENTLY no-opping, which leaves the layer
    // gate green and empty.
    const deps = readJsonc('package.json').devDependencies as Record<string, string>;
    expect(deps.typescript).toBe('~5.9.3');
  });

  it('pins the package manager exactly, never a range', () => {
    const pkg = readJsonc('package.json');
    expect(pkg.packageManager).toMatch(/^yarn@4\.\d+\.\d+$/);
  });

  it('requires a Node new enough that it is not EOL', () => {
    const engines = readJsonc('package.json').engines as Record<string, string>;
    expect(engines.node).toBe('>=24.10.0');
  });
});

describe('the layer gate', () => {
  const config = require(path.join(ROOT, '.dependency-cruiser.js')) as {
    forbidden: { name: string; severity: string }[];
    options: { tsPreCompilationDeps: boolean };
  };
  const policy = require(path.join(ROOT, 'tools', 'dependency-policy.js')) as {
    ranksOf: (relativePath: string) => number[];
  };

  it('keeps tsPreCompilationDeps on', () => {
    // Measured, not assumed: with this false, a type-only import edge is invisible and
    // the same two files report "no dependency violations found". That is the
    // silent-no-op mode the whole gate exists to avoid.
    expect(config.options.tsPreCompilationDeps).toBe(true);
  });

  it('keeps exec below the adapters that must consume it', () => {
    // The RELATION, not the literal number. Every rank inserted below the seams shifts
    // `docker-cli`'s index, and an assertion on the index fails on a change that does not
    // touch the property it is named after -- which is how a gate gets edited to make a
    // suite green. Each path must map to exactly ONE rank, because two would let a module
    // satisfy the lower and import as the higher.
    const exec = policy.ranksOf('src/seams/exec.ts');
    const adapter = policy.ranksOf('src/seams/docker-cli.ts');
    expect(exec).toEqual([0]);
    expect(adapter).toHaveLength(1);
    expect(adapter[0]).toBeGreaterThan(exec[0] as number);
  });

  it('forbids cycles and off-seam process launches at error severity', () => {
    const byName = new Map(config.forbidden.map((r) => [r.name, r]));
    for (const name of ['no-circular', 'only-exec-launches-processes']) {
      expect(byName.get(name)?.severity).toBe('error');
    }
  });

  it('generates one downward-only rule per populated rank', () => {
    // The rules are generated from the rank table rather than written out, because a
    // hand-kept "rank 2 may not reach 3, 4, 5, 6" is n-squared lines that drift the
    // first time a rank is inserted — and a drifted layer rule fails OPEN.
    const layerRules = config.forbidden.filter((r) => r.name.startsWith('layer-'));
    expect(layerRules.length).toBeGreaterThanOrEqual(7);
    for (const rule of layerRules) {
      expect(rule.severity).toBe('error');
      expect(rule.name).toMatch(/^layer-\d+-imports-down-only$/);
    }
  });

  it('refuses a production module that is absent from the rank table', () => {
    const probe = path.join(ROOT, 'src', 'lib', '__unmapped_module_probe.ts');
    expect(fs.existsSync(probe)).toBe(false);
    try {
      fs.writeFileSync(probe, 'export const unmapped = 1;\n', 'utf8');
      const result = runYarn('depcruise');
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('unmapped-production-module');
      expect(`${result.stdout}\n${result.stderr}`).toContain('src/lib/__unmapped_module_probe.ts');
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });

  it('self-tests a forbidden layer edge as well as a cycle and seam bypass', () => {
    const result = run(process.execPath, [path.join(ROOT, 'tools', 'depcruise-selftest.js')]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('REPORTED  no-circular');
    expect(result.stdout).toContain('REPORTED  layer-0-imports-down-only');
    expect(result.stdout).toContain('REPORTED  only-exec-launches-processes');
  });
});

describe('lint-enforced architecture', () => {
  const eslint = path.join(ROOT, 'node_modules', '.bin', 'eslint');

  it('allows the designated exec seam to import child_process', () => {
    // This proves the exception is attached to the actual seam's path.
    const result = run(eslint, ['--print-config', 'src/seams/exec.ts']);
    expect(result.status).toBe(0);
    const config = JSON.parse(result.stdout) as { rules: Record<string, unknown[]> };
    expect(config.rules['no-restricted-imports']?.[0]).toBe(0);
  });

  it('rejects treating an Answer object as boolean at a consumer', () => {
    const dir = path.join(ROOT, 'src', 'core');
    const probe = path.join(dir, '__answer_truthiness_probe.ts');
    fs.mkdirSync(dir, { recursive: true });
    expect(fs.existsSync(probe)).toBe(false);
    try {
      fs.writeFileSync(
        probe,
        [
          "type Answer = { kind: 'yes' } | { kind: 'no' } | { kind: 'refused'; reason: string };",
          'export function consume(answer: Answer): string {',
          "  if (answer) return 'yes';",
          "  return 'no';",
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      const result = run(eslint, [path.relative(ROOT, probe)]);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        '@typescript-eslint/no-unnecessary-condition',
      );
    } finally {
      fs.rmSync(probe, { force: true });
      try {
        fs.rmdirSync(dir);
      } catch {
        // src/core holds real modules; never remove its directory.
      }
    }
  });
});
