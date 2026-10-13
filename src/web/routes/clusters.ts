/** Cluster inventory and managed-cluster operations. */

import type { FastifyInstance } from 'fastify';

import * as audit from '../../core/audit';
import { ConflictError, ValidationError } from '../../lib/errors';
import { toInt, quotedText, stripText, isTruthy } from '../../lib/format';
import { bool, orText, queryBool, queryText, requestBody, submit } from '../route-deps';
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

  app.get('/api/clusters/connection', async () => {
    const eks = eksModule();
    const [who, region] = await Promise.all([eks.whoami(), eks.region()]);
    const profile = process.env.AWS_PROFILE ?? '';
    const source =
      process.env.AWS_ACCESS_KEY_ID !== undefined
        ? process.env.AWS_SESSION_TOKEN !== undefined
          ? 'temporary environment credentials'
          : 'environment access keys'
        : process.env.AWS_WEB_IDENTITY_TOKEN_FILE !== undefined
          ? 'workload role'
          : process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI !== undefined ||
              process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI !== undefined
            ? 'container role'
            : profile !== ''
              ? 'named profile'
              : 'server credential chain';
    // Only when it would help: not signed in, and no profile named.
    const profiles = who.error !== '' && profile === '' ? await eks.profiles() : [];
    return {
      profile,
      profiles,
      source,
      account: who.account,
      principal: who.arn,
      error: who.error,
      region,
    };
  });

  app.post('/api/clusters/connect', async (request) => {
    const arn = stripText(orText(requestBody(request.body, true).context));
    const connected = await eksModule().connectExisting(arn);
    audit.record('cluster-connect', arn);
    return connected;
  });

  // The one answer the Clusters page, the Home card and the build flow render: every
  // known cluster read through status(), the totals, the preflight and the next step.
  // A build running right now is a job, and the next step says so. The AWS tool and
  // identity checks are reused between reads; `?fresh=1` (the build flow's Re-check)
  // asks again.
  app.get<{ Querystring: { fresh?: unknown } }>('/api/clusters/overview', async (request) => {
    const building = app.jobs
      .listJobs()
      .filter((job) => job.kind === 'cluster-create' && job.status === 'running')
      .map((job) => job.label);
    return await clusterModule().overview(undefined, {
      building,
      reuse: !queryBool(request.query.fresh, false, 'fresh'),
    });
  });

  // What a build of N nodes costs, from the same table the ledger prices with. The
  // dialog carried a hardcoded string that did not follow the node count.
  app.get<{ Querystring: { nodes?: unknown } }>('/api/clusters/estimate', async (request) => {
    const raw = queryText(request.query.nodes, '3', 'nodes');
    let nodes: number;
    try {
      nodes = toInt(raw);
    } catch {
      throw new ValidationError('`nodes` wants a whole number');
    }
    if (nodes < 1 || nodes > 100) throw new ValidationError('`nodes` wants a number from 1 to 100');
    const eks = eksModule();
    const cost = clusterModule().estimateUsdHr(
      'eks',
      { [eks.NODE_INSTANCE_TYPE]: nodes },
      {
        loadbalancers: 1,
        volumeGb: 0,
        version: eks.K8S_VERSION,
      },
    );
    if (cost === null)
      throw new ValidationError('this build cannot be priced: the table has no rate for it');
    return {
      nodes,
      instance_type: eks.NODE_INSTANCE_TYPE,
      usd_hr: cost.usd_hr,
      usd_day: Math.round(cost.usd_hr * 24 * 100) / 100,
      basis: cost.basis,
      kubernetes_version: eks.K8S_VERSION,
    };
  });

  // Whether a name reaches the cluster's load balancer: the check the DNS step of the
  // build flow offers, so nobody needs dig. `matches` is null when there is no target.
  app.get<{ Querystring: { host?: unknown; target?: unknown } }>(
    '/api/clusters/dns-check',
    async (request) => {
      const host = stripText(queryText(request.query.host, '', 'host'));
      if (host === '') throw new ValidationError('`host` is required: the name to resolve.');
      const target = stripText(queryText(request.query.target, '', 'target'));
      const answers = await clusterModule().resolveName(host);
      const bare = (name: string): string => name.toLowerCase().replace(/\.$/u, '');
      const matches =
        target === '' ? null : answers.some((answer) => bare(answer) === bare(target));
      // No CNAME but addresses means a proxy answers for the name, not a missing record.
      const addresses = answers.length === 0 ? await clusterModule().resolveAddresses(host) : [];
      return { host, target, answers, matches, addresses };
    },
  );

  // The EKS guide, for the Guide link on the Clusters page: the same file `cluster guide` prints.
  app.get('/api/docs/eks', async () => {
    const eks = eksModule();
    return { path: eks.guidePath(), body: eks.guide() };
  });

  // Approving the account for spending, from the build flow's second step. The one
  // config write the web layer has: two keys, the same two `houston config set` writes,
  // admin only and audited, because approving means any admin here can start a cluster
  // that costs money.
  app.post('/api/clusters/approve', async (request) => {
    const body = requestBody(request.body, true);
    const account = stripText(orText(body.account));
    const out = await eksModule().approveAccount(account, {
      acmeEmail: stripText(orText(body.acme_email)),
    });
    audit.record('cluster-approve', account);
    return out;
  });
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
          zone: stripText(orText(body.zone)),
          ...(subnets === undefined ? {} : { subnets }),
          emit,
        }),
      { label: name, region },
    );
  });

  app.post('/api/clusters/delete', async (request) => {
    const eks = eksModule();
    const body = requestBody(request.body, true);
    const name = stripText(orText(body.name));
    if (name === '') throw new ValidationError('`name` is required: which cluster to delete.');
    const region = stripText(orText(body.region));
    const expectedArn = stripText(orText(body.context));
    const resolvedRegion =
      region || eks.rememberedRegion(name) || (await eks.aws.preflight()).region;
    return submit(
      app,
      'cluster-delete',
      async (emit) => {
        const deleted = await eks.deleteCluster(name, {
          region: resolvedRegion,
          expectedArn,
          force: bool(body.force),
          emit,
        });
        // `false` stays false: the page treats it as "nothing to delete". A delete that
        // went through ends with what AWS still holds, because "done" is not "not billing".
        if (!deleted) return false;
        return {
          deleted,
          region: resolvedRegion,
          leftovers: await eks.sweepLeftovers(name, resolvedRegion),
        };
      },
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
