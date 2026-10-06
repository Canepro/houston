/** One workspace's host routes /grafana to the cluster's shared Grafana. */
import { createHash } from 'node:crypto';

import { ConflictError } from '../../lib/errors';
import { info, nullEmit, warn, type Emit } from '../../lib/events';
import { budgetWarning, recordIssuance } from '../tls';

import { askObject, present, require_ } from './ask';
import { issuerName, waitForCertificate, type IssuerSpec } from './certmanager';
import {
  GRAFANA_INGRESS_LABEL,
  GRAFANA_PORT,
  GRAFANA_SERVICE,
  MONITORING_NAMESPACE,
} from './monitoring';
import { APPLY_TIMEOUT, OWNER_LABEL_KEY, OWNER_LABEL_VALUE, WORKSPACE_LABEL } from './names';
import { labelsFor } from './namespace';
import { apply } from './release';

function bag(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Leave four characters for the TLS Secret suffix, with a stable collision-resistant tail. */
export function grafanaIngressName(workspace: string): string {
  const raw = `grafana-${workspace}`;
  return raw.length <= 59
    ? raw
    : `grafana-${workspace.slice(0, 42).replace(/-+$/u, '')}-${createHash('sha256').update(workspace).digest('hex').slice(0, 8)}`;
}

export function grafanaIngressManifest(
  workspace: string,
  host: string,
  ingressClass: string,
  issuer: IssuerSpec,
): string {
  const name = grafanaIngressName(workspace);
  const labels = { ...labelsFor(workspace), [GRAFANA_INGRESS_LABEL]: 'true' };
  return JSON.stringify({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name,
      namespace: MONITORING_NAMESPACE,
      labels,
      annotations: {
        'cert-manager.io/cluster-issuer': issuerName(issuer),
        // ingress-shim copies the Ingress labels to the Certificate; this also labels
        // its Secret, so all three resources can be reclaimed by the same selector.
        'cert-manager.io/secret-template': JSON.stringify({ labels }),
      },
    },
    spec: {
      ingressClassName: ingressClass,
      tls: [{ hosts: [host], secretName: `${name}-tls` }],
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path: '/grafana',
                pathType: 'Prefix',
                backend: { service: { name: GRAFANA_SERVICE, port: { number: GRAFANA_PORT } } },
              },
            ],
          },
        },
      ],
    },
  });
}

export async function ensureGrafanaIngress(
  workspace: string,
  {
    context,
    publicUrl,
    ingressClass,
    issuer,
    emit = nullEmit,
  }: { context: string; publicUrl: string; ingressClass: string; issuer: IssuerSpec; emit?: Emit },
): Promise<void> {
  const host = new URL(publicUrl).hostname;
  const name = grafanaIngressName(workspace);
  let newCertificate = false;
  for (const [kind, resource] of [
    ['ingress', name],
    ['certificate', `${name}-tls`],
    ['secret', `${name}-tls`],
  ]) {
    // APPLY_TIMEOUT: a must-answer question inside an attach job, as in `removeGrafanaIngress`.
    const seen = require_(
      await askObject(kind as string, resource as string, {
        namespace: MONITORING_NAMESPACE,
        context,
        timeout: APPLY_TIMEOUT,
      }),
      `Grafana ${kind} '${resource}'`,
      { context },
    );
    if (present(seen)) {
      const labels = bag(bag(seen.doc.metadata).labels);
      if (
        labels[OWNER_LABEL_KEY] !== OWNER_LABEL_VALUE ||
        labels[WORKSPACE_LABEL] !== workspace ||
        labels[GRAFANA_INGRESS_LABEL] !== 'true'
      )
        throw new ConflictError(
          `Grafana ${kind} '${resource}' in ${MONITORING_NAMESPACE} belongs to somebody else`,
        );
      if (kind === 'certificate') {
        const spec = bag(seen.doc.spec);
        newCertificate =
          !Array.isArray(spec.dnsNames) ||
          !spec.dnsNames.includes(host) ||
          bag(spec.issuerRef).name !== issuerName(issuer);
      }
    } else if (kind === 'certificate') newCertificate = true;
  }
  info(emit, `serving ${publicUrl}/grafana through the shared stack`, { phase: 'monitor' });
  await apply(grafanaIngressManifest(workspace, host, ingressClass, issuer), {
    namespace: MONITORING_NAMESPACE,
    context,
  });
  if (issuer.mode === 'acme' && newCertificate) {
    recordIssuance(host, '', `${context}:${MONITORING_NAMESPACE}:${name}-tls`);
    const warning = budgetWarning(host);
    if (warning) warn(emit, warning, { phase: 'tls' });
  }
  await waitForCertificate(`${name}-tls`, { namespace: MONITORING_NAMESPACE, context, emit });
}
