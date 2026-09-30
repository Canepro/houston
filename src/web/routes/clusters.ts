/** Cluster inventory and managed-cluster operations. */

import type { FastifyInstance } from 'fastify';

import { ConflictError, ValidationError } from '../../lib/errors';
import { toInt, quotedText, stripText, isTruthy } from '../../lib/format';
import { bool, orText, queryText, requestBody, submit } from '../route-deps';
import type * as ClusterNS from '../../core/cluster';
import type * as EksNS from '../../core/eks';
import type * as KubeContextNS from '../../core/kube/context';
import type * as ReachabilityNS from '../../core/kube/reachability';

function clusterModule(): typeof ClusterNS {
  return require('../../core/cluster') as typeof ClusterNS;
}

function eksModule(): typeof EksNS {
  return require('../../core/eks') as typeof EksNS;
}

function kubeContextModule(): typeof KubeContextNS {
  return require('../../core/kube/context') as typeof KubeContextNS;
}

function reachabilityModule(): typeof ReachabilityNS {
  return require('../../core/kube/reachability') as typeof ReachabilityNS;
}

export function register(app: FastifyInstance): void {
  app.get('/api/clusters', async () => await clusterModule().knownContexts());
  app.get<{ Querystring: { context?: unknown } }>(
    '/api/clusters/status',
    async (request) =>
      await clusterModule().status(stripText(queryText(request.query.context, '', 'context'))),
  );
  app.get<{ Querystring: { name?: unknown } }>('/api/clusters/iam-policy', async (request) => {
    const eks = eksModule();
    const name = queryText(request.query.name, '', 'name');
    const documents = name
      ? [
          {
            name,
            filename: eks.IAM_DOCUMENTS[name]?.[0] ?? '',
            purpose: eks.IAM_DOCUMENTS[name]?.[1] ?? '',
            body: eks.iamDocument(name),
          },
        ]
      : Object.entries(eks.IAM_DOCUMENTS)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, [filename, purpose]]) => ({
            name: key,
            filename,
            purpose,
            body: eks.iamDocument(key),
          }));
    return { documents };
  });

  app.post('/api/clusters/sweep', async (request) => {
    const eks = eksModule();
    const body = requestBody(request.body, false);
    const region = stripText(orText(body.region));
    return submit(
      app,
      'cluster-sweep',
      (emit) =>
        eks.sweepClusters({
          ...(region === '' ? {} : { regions: [region] }),
          ownedOnly: !bool(body.all),
          emit,
        }),
      { label: region || 'all regions' },
    );
  });

  app.post('/api/clusters/prepare', async (request) => {
    const eks = eksModule();
    const context = stripText(orText(requestBody(request.body, true).context));
    if (context === '')
      throw new ValidationError('`context` is required: which cluster to prepare.');
    return submit(app, 'cluster-prepare', (emit) => eks.prepareCluster(context, { emit }), {
      label: context,
    });
  });

  app.post('/api/clusters/create', async (request) => {
    const eks = eksModule();
    const body = requestBody(request.body, true);
    const name = stripText(orText(body.name));
    if (name === '') throw new ValidationError('`name` is required, e.g. {"name": "support"}');
    const rawSubnets = isTruthy(body.subnets) ? body.subnets : {};
    if (typeof rawSubnets !== 'object' || Array.isArray(rawSubnets)) {
      throw new ValidationError('`subnets` wants an object of {availability-zone: subnet-id}');
    }
    const rawExpires = stripText(orText(body.expires)).toLowerCase();
    let expiresDays: number | null = eks.DEFAULT_EXPIRY_DAYS;
    if (rawExpires === 'never') expiresDays = null;
    else if (rawExpires !== '') {
      try {
        expiresDays = toInt(rawExpires);
      } catch {
        throw new ValidationError(
          `\`expires\` wants a number of days or "never", got ${quotedText(rawExpires)}`,
        );
      }
    }
    let nodes: number;
    try {
      nodes = isTruthy(body.nodes) ? toInt(body.nodes) : 0;
    } catch {
      throw new ValidationError('`nodes` wants a whole number');
    }
    const region = stripText(orText(body.region));
    const subnets = Object.keys(rawSubnets as Record<string, string>).length
      ? (rawSubnets as Record<string, string>)
      : undefined;
    return submit(
      app,
      'cluster-create',
      (emit) =>
        eks.createCluster(name, {
          region,
          nodes: nodes || eks.DEFAULT_NODES,
          expiresDays,
          ...(subnets === undefined ? {} : { subnets }),
          emit,
        }),
      { label: name },
    );
  });

  app.post('/api/clusters/delete', async (request) => {
    const eks = eksModule();
    const body = requestBody(request.body, true);
    const name = stripText(orText(body.name));
    if (name === '') throw new ValidationError('`name` is required: which cluster to delete.');
    const region = stripText(orText(body.region));
    return submit(
      app,
      'cluster-delete',
      (emit) => eks.deleteCluster(name, { region, force: bool(body.force), emit }),
      { label: name },
    );
  });

  app.post('/api/clusters/forget', async (request) => {
    const body = requestBody(request.body, true);
    const context = stripText(orText(body.context));
    if (context === '') throw new ValidationError('`context` is required: which entry to forget.');
    const reachability = reachabilityModule();
    if (!bool(body.force) && reachability.reachOk(await reachability.reach(context))) {
      throw new ConflictError(
        `${quotedText(context)} is answering, so it is a cluster you can still use rather than a ` +
          'leftover entry. Delete the cluster to remove it.',
      );
    }
    if (!(await kubeContextModule().forgetContext(context))) {
      throw new ConflictError(
        `${context} is still named by a kubeconfig on this machine. Remove it by hand: ` +
          `\`kubectl config delete-context ${context}\``,
      );
    }
    return { context, forgotten: true };
  });
}
