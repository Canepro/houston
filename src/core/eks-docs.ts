/**
 * The EKS walkthrough houston ships, and the permissions it tells you to grant.
 *
 * The only part of the EKS work that asks AWS nothing: static text, a file on disk, and a
 * table of documents somebody has to approve before any of the rest can run.
 *
 * ONE COPY ON DISK. `config.dataPath` resolves into `data/`, which the previous
 * implementation reads too, through a symlink, so the guide and the three IAM documents
 * are the same bytes for both -- which matters more than usual here, because these are
 * pasted into `aws iam create-policy` and `kubectl apply` verbatim.
 */
import * as fs from 'node:fs';

import { dataPath } from '../lib/config';
import { PreflightError, ValidationError } from '../lib/errors';

/**
 * The documents that let a NON-ROOT identity run houston against EKS, shipped rather
 * than described. Each was verified by using it: an IAM user holding only
 * `operator-policy.json` built a cluster, ran a workspace on it and deleted it, and the
 * two permissions in it that nobody would guess -- `ec2:RunInstances`, which EKS checks
 * against the CALLER even though EKS launches the nodes, and
 * `cloudformation:UpdateTerminationProtection`, which fails only on delete and only
 * after the cluster is half gone -- are there because a live run failed without them.
 *
 * SHIPPED, not documented. A policy that lives in a design note is a policy somebody
 * retypes, and a retyped policy is one of these two actions short -- which produces a
 * cluster with zero nodes that bills at full rate and cannot run anything.
 */
export const IAM_DOCUMENTS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  operator: [
    'operator-policy.json',
    'AWS permissions to CREATE and DELETE clusters. Too long for an inline user policy ' +
      '(2,048 chars) — attach it as a customer-managed policy, or inline on a role, ' +
      'which allows 10,240.',
  ],
  engineer: [
    'engineer-policy.json',
    'AWS permissions to USE a cluster somebody else built. Two read actions, and NOT ' +
      'sufficient on its own — see `rbac` below.',
  ],
  rbac: [
    'engineer-rbac.yaml',
    'Kubernetes permissions for the same person. IAM gets them a kubeconfig; the ' +
      'cluster then refuses it until an EKS access entry exists. Apply this once per ' +
      "cluster, as the cluster's creator.",
  ],
});

/**
 * The end-to-end EKS walkthrough, shipped rather than left in a repository somebody may
 * not have. The person most likely to need it is setting houston up on a machine that is
 * not the one it was developed on, and "read the README on GitHub" is a poor answer when
 * the tool is already installed in front of them.
 */
export const GUIDE_FILE = 'eks.md';

/** Where the shipped EKS guide is on this machine, or null if it is not there. */
export function guidePath(): string | null {
  const candidate = dataPath('docs', GUIDE_FILE);
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/** The EKS walkthrough, verbatim. */
export function guide(): string {
  const path = guidePath();
  if (path === null) {
    throw new PreflightError(
      `${GUIDE_FILE} is missing from this install. It is shipped package data, so this ` +
        'is a broken or stale install.',
    );
  }
  return fs.readFileSync(path, 'utf8');
}

/**
 * One shipped permissions document, verbatim.
 *
 * Verbatim matters more than it looks: this text is pasted into `aws iam create-policy`
 * and `kubectl apply`, so anything houston added to be helpful -- a header, a trailing
 * note, a reformat -- is a syntax error in somebody's terminal.
 */
export function iamDocument(which: string): string {
  const entry = IAM_DOCUMENTS[which];
  if (entry === undefined) {
    throw new ValidationError(
      `unknown permissions document '${which}'. Want: ` +
        `${Object.keys(IAM_DOCUMENTS).sort().join(' | ')}.`,
    );
  }
  const path = dataPath('iam', entry[0]);
  try {
    if (!fs.statSync(path).isFile()) throw new Error('not a file');
  } catch {
    throw new PreflightError(
      `${entry[0]} is missing from this install. It is shipped package data, so this is ` +
        'a broken or stale install.',
    );
  }
  return fs.readFileSync(path, 'utf8');
}
