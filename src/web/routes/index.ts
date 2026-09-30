/** Register the twelve route modules in the established order. */

import type { FastifyInstance } from 'fastify';

import * as backup from './backup';
import * as clusters from './clusters';
import * as data from './data';
import * as edge from './edge';
import * as jobs from './jobs';
import * as logs from './logs';
import * as meta from './meta';
import * as people from './people';
import * as perf from './perf';
import * as repros from './repros';
import * as session from './session';
import * as spa from './spa';

export function registerAll(app: FastifyInstance): void {
  session.register(app);
  people.register(app);
  meta.register(app);
  repros.register(app);
  logs.register(app);
  data.register(app);
  backup.register(app);
  clusters.register(app);
  edge.register(app);
  perf.register(app);
  jobs.register(app);
  spa.register(app);
}
