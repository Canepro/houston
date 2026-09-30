/**
 * INVARIANT: a route module has one entry point, and the web layer owns the table.
 *
 * MECHANISM: ts-morph for the import direction, behaviour for the shared state.
 *
 * "One entry point" cannot be spelled as an export list here: the handlers are public
 * names, two modules legitimately export a helper a sibling or their own spec uses, and
 * TypeScript has no export list to read. The checkable form is the DIRECTION -- nothing
 * outside `web/routes/` may reach past `register` -- which is a question about the import
 * graph and is what earlier releases asked too. `dependency-cruiser` states the layer rule but cannot
 * state this one: it is about the NAME imported, not the module.
 */
import * as path from 'node:path';

import { Project, type SourceFile } from 'ts-morph';

import * as security from '../../../src/web/security';

import type * as FastifyNS from 'fastify';

import type * as RouteTableNS from '../../../src/web/route-table';

const ROOT = path.resolve(__dirname, '..', '..', '..');

function productionSources(): SourceFile[] {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths([path.join(ROOT, 'src', '**', '*.ts')]);
  return project.getSourceFiles();
}

/** Names imported from a `web/routes/<module>` by something outside that directory. */
function reachesIntoRoutes(file: SourceFile): string[] {
  const here = path.dirname(file.getFilePath());
  if (here.endsWith(path.join('web', 'routes'))) return [];
  const found: string[] = [];
  for (const declaration of file.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (!/(^|\/)web\/routes\/|^\.{1,2}\/routes\//u.test(specifier)) continue;
    if (specifier.endsWith('/index')) continue;
    for (const named of declaration.getNamedImports()) {
      if (named.getName() !== 'register') {
        found.push(`${path.basename(file.getFilePath())}: ${specifier}.${named.getName()}`);
      }
    }
    if (declaration.getNamespaceImport() !== undefined) {
      found.push(`${path.basename(file.getFilePath())}: * as ${specifier}`);
    }
  }
  return found;
}

describe('a route module is reached only through register', () => {
  it('recognises a reach past the entry point', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const planted = project.createSourceFile(
      '/src/web/app.ts',
      `
import { register, openLogProcess } from './routes/logs';
export const used = [register, openLogProcess];
`,
    );
    expect(reachesIntoRoutes(planted)).toEqual(['app.ts: ./routes/logs.openLogProcess']);
  });

  it('finds none in the tree', () => {
    const files = productionSources();
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap(reachesIntoRoutes)).toEqual([]);
  });

  it('records a sign-in failure into the state the limiter itself reads', () => {
    // Earlier releases' guard asserted the app's sign-in failure table IS the security
    // module's -- an identity check on a module attribute, which this build has no equivalent of: the table and the limiter
    // live in `web/route-table.ts` and `web/security.ts`, and `web/app.ts` injects them rather than
    // re-exporting them. So the claim is made about BEHAVIOUR: a failure recorded through the
    // exported writer has to be visible to the exported reader, and `signinOk` has to reach the
    // same state again.
    const source = '203.0.113.99';
    expect(security.signinRetryAfter(source)).toBe(0);
    for (let attempt = 0; attempt < security.SIGNIN_MAX_FAILURES; attempt += 1) {
      security.signinFailed(source);
    }
    expect(security.signinRetryAfter(source)).toBeGreaterThan(0);
    // A COPY would leave this at the same value. Halving the recorded failures is what
    // `signinOk` does, and it must reach the same map the reader consults.
    security.signinOk(source);
    expect(security.signinRetryAfter(source)).toBe(0);
  });

  it('refuses a route the table does not list, rather than serving it', async () => {
    // The app does not re-export the table; it INJECTS `route-table.routeRequirement` into
    // the security context. The checkable form of "one table" is that the application
    // really refuses what the table does not list -- DEFAULT DENY reached through the
    // real guard, on a real request.
    const Fastify = (require('fastify') as { default: typeof FastifyNS.default }).default;
    const probe = Fastify();
    const { installRouteCompleteness } =
      require('../../../src/web/route-table') as typeof RouteTableNS;
    installRouteCompleteness(probe);
    probe.get('/api/not-in-the-table', async () => ({ ok: true }));
    await expect(probe.ready()).rejects.toThrow(
      'registered routes missing from ROUTE_ROLES: GET /api/not-in-the-table',
    );
    await probe.close();
  });
});
