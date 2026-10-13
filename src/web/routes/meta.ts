/** Box-level health, settings, capacity, presets, and version resolution. */

import { seedCatalogue } from '../../lib/seed-options';
import type { FastifyInstance } from 'fastify';

import { maySetPrivilegedFields } from '../../core/lifecycle/ownership';
import { unsupportedFields } from '../../core/lifecycle/preconditions';
import { capacity, runtimeCost } from '../../core/lifecycle/sizing';
import { PRIVILEGED_CREATE_FIELDS } from '../../core/lifecycle/types';
import { dockerAvailable, dockerKernelVersion } from '../../core/runner/host';
import * as topology from '../../core/topology';
import * as config from '../../lib/config';
import { ValidationError } from '../../lib/errors';
import { isTruthy } from '../../lib/format';
import { listPresets } from '../../lib/presets';
import { actor, bag, queryBool } from '../route-deps';
import type * as ClusterNS from '../../core/cluster';
import type * as DoctorNS from '../../core/doctor';
import type * as KubeProbeNS from '../../core/kube/probe';
import type * as KubeToolsNS from '../../core/kube/tools';
import type * as RequestNS from '../../core/lifecycle/request';
import type * as MongoKernelNS from '../../lib/mongo-kernel';
import type * as VersionsNS from '../../lib/versions';
import type * as PresetsNS from '../../lib/presets/index';

function clusterModule(): typeof ClusterNS {
  return require('../../core/cluster') as typeof ClusterNS;
}

function doctorModule(): typeof DoctorNS {
  return require('../../core/doctor') as typeof DoctorNS;
}

function kubeModules(): { probe: typeof KubeProbeNS; tools: typeof KubeToolsNS } {
  return {
    probe: require('../../core/kube/probe') as typeof KubeProbeNS,
    tools: require('../../core/kube/tools') as typeof KubeToolsNS,
  };
}

function requestModule(): typeof RequestNS {
  return require('../../core/lifecycle/request') as typeof RequestNS;
}

function mongoKernelModule(): typeof MongoKernelNS {
  return require('../../lib/mongo-kernel') as typeof MongoKernelNS;
}

/** Whether a preset has what Kubernetes needs: an adapter, or no services at all. */
function worksOnKubernetes(name: string): boolean {
  try {
    const resolved = (require('../../lib/presets/index') as typeof PresetsNS).resolve(
      name,
      'kubernetes',
      {},
    );
    return Object.keys(resolved.services).length === 0 || resolved.kubernetesManifests.length > 0;
  } catch {
    return false;
  }
}

function versionsModule(): typeof VersionsNS {
  return require('../../lib/versions') as typeof VersionsNS;
}

async function kubeClusters(): Promise<{
  contexts: Awaited<ReturnType<typeof ClusterNS.knownContexts>>['contexts'];
  unreadable: string;
}> {
  try {
    const known = await clusterModule().knownContexts();
    return { contexts: known.contexts, unreadable: known.unreadable };
  } catch {
    return { contexts: [], unreadable: '' };
  }
}

export function register(app: FastifyInstance): void {
  app.get('/api/health', async () => ({ ok: true, docker: await dockerAvailable() }));

  app.get('/api/kubernetes', async () => {
    try {
      const kube = kubeModules();
      const pre = await kube.probe.preflight();
      const known = await kubeClusters();
      return {
        usable: kube.tools.toolsReady(pre) && pre.clusterReachable,
        tools_ready: kube.tools.toolsReady(pre),
        reachable: pre.clusterReachable,
        context: pre.context,
        distribution: pre.distribution,
        can_provision: kube.tools.canProvision(pre),
        nodes: pre.nodeCount,
        workspaces: pre.namespaces.length,
        // How many the kubeconfig names: with none current, the footer says so rather
        // than "not set up" beside a Clusters page listing them as running.
        contexts: known.contexts.length,
        // And why it could not be read at all: the footer said "not set up" beside a
        // Clusters page saying "This machine's kubeconfig could not be read".
        unreadable: known.unreadable,
      };
    } catch {
      return { usable: false, reachable: false, contexts: 0, unreadable: '' };
    }
  });

  app.get('/api/doctor', async () => {
    const report = await doctorModule().runChecks();
    const checks = Array.isArray(report.checks)
      ? report.checks.filter(
          (row) => !(typeof row === 'object' && row !== null && 'elsewhere' in (row as object)),
        )
      : [];
    return { ...report, checks };
  });

  app.get('/api/settings', async (request) => {
    const cfg = config.loadConfig();
    return {
      acme_email_remembered: Boolean(cfg.acme_email),
      may_set_privileged: maySetPrivilegedFields(actor(request)),
      privileged_fields: [...PRIVILEGED_CREATE_FIELDS],
      kube_clusters: (await kubeClusters()).contexts,
      runtimes: Object.entries(topology.DEPLOYMENTS).map(([runtime, deployments]) => ({
        name: runtime,
        deployments: [...deployments],
        default_deployment: deployments[0],
        cost: Object.fromEntries(deployments.map((name) => [name, runtimeCost(runtime, name)])),
        unsupported: unsupportedFields(runtime),
      })),
      default_runtime: topology.DOCKER,
      seed_options: seedCatalogue(),
      default_bind_host: String(isTruthy(cfg.bind_host) ? cfg.bind_host : config.DEFAULT_BIND_HOST),
    };
  });

  app.get('/api/machine', async () => await capacity());

  app.get('/api/presets', async () => ({
    presets: listPresets().map((preset) => ({
      name: preset.name,
      description: preset.description,
      params_help: preset.paramsHelp,
      requires_license: preset.requiresLicense,
      notes: [...preset.notes],
      ports: [...(config.PRESET_PORTS[preset.name] ?? [])],
      // Whether it can be created on Kubernetes, alone or in a set.
      kubernetes: worksOnKubernetes(preset.name),
    })),
  }));

  app.get<{ Params: { version: string } }>('/api/versions/:version', async (request) => {
    const versions = versionsModule();
    const query = bag(request.query);
    const offline = queryBool(query.offline, false, 'offline');
    // An invalid version is refused by `resolve` below WITHOUT asking the network first:
    // the path segment is whatever the caller typed, and it went into an outbound URL.
    const fetcher = await requestModule().releaseFetcher(request.params.version, offline);
    let resolved;
    try {
      resolved = versions.resolve(request.params.version, {
        offline,
        ...(fetcher === undefined ? {} : { fetcher }),
      });
    } catch (error) {
      if (error instanceof versions.InvalidVersionError) throw new ValidationError(error.message);
      throw error;
    }
    const kernel = (await dockerKernelVersion()) ?? '';
    const conflict = mongoKernelModule().mongoKernelConflict(resolved.mongoTag, kernel);
    return {
      rc_version: resolved.rcVersion,
      rc_image: resolved.rcImage,
      mongo_tag: resolved.mongoTag,
      mongo_flavor: resolved.mongoFlavor,
      mongo_shell: resolved.mongoShell,
      oplog: resolved.oplog,
      source: resolved.source,
      note: resolved.note,
      kernel,
      ...(conflict === '' ? {} : { warning: conflict }),
    };
  });
}
