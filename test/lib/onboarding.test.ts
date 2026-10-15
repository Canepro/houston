import { AuthorityGateError, ValidationError } from '../../src/lib/errors';
import {
  answeredGrants,
  checkGrantId,
  complete,
  grant,
  grantIds,
  heldGrants,
  holdsGrant,
  OWNED_CLUSTER_SCOPE,
  requireGrant,
  requireOnboarded,
  revoke,
  state,
} from '../../src/lib/onboarding';

import type { Config } from '../../src/lib/config';

const WHEN = new Date('2026-10-15T00:00:00Z');

describe('persisted onboarding grants', () => {
  it('keeps an additive mapping and distinguishes granted, denied, and unanswered', () => {
    const cfg: Config = {
      grants: { future_grant: true, owned_cluster: false, clusters: ['someone-elses-cluster'] },
      onboarding: { future_marker: 'keep' },
    };

    expect(state(cfg)).toMatchObject({
      completed: false,
      rc_repro_version: '',
      grants: { owned_cluster: false },
      answered_grants: { owned_cluster: true },
      clusters: ['someone-elses-cluster'],
      grants_available: [
        { id: 'owned-cluster', gate: 'GATE_OWNED_CLUSTER', held: false, answered: true },
      ],
    });
    expect(heldGrants(cfg)).toEqual([]);
    expect(answeredGrants(cfg)).toEqual(['owned-cluster']);
    expect(holdsGrant('owned-cluster', cfg)).toBe(false);
    expect(() => requireOnboarded(cfg)).toThrow(AuthorityGateError);
    try {
      requireOnboarded(cfg);
    } catch (error) {
      expect(error).toMatchObject({ code: 'GATE_NOT_ONBOARDED' });
    }
    expect(() => requireGrant('owned-cluster', cfg)).toThrow(AuthorityGateError);

    grant(cfg, 'owned-cluster', WHEN);
    expect(cfg).toEqual({
      grants: {
        future_grant: true,
        owned_cluster: true,
        clusters: ['someone-elses-cluster', OWNED_CLUSTER_SCOPE],
      },
      onboarding: {
        future_marker: 'keep',
        completed_at: '2026-10-15T00:00:00+00:00',
        rc_repro_version: expect.any(String),
      },
    });
    expect(heldGrants(cfg)).toEqual(['owned-cluster']);
    expect(() => requireOnboarded(cfg)).not.toThrow();
    expect(() => requireGrant('owned-cluster', cfg)).not.toThrow();

    revoke(cfg, 'owned-cluster', new Date('2026-10-16T00:00:00Z'));
    try {
      requireGrant('owned-cluster', cfg);
    } catch (error) {
      expect(error).toMatchObject({ code: 'GATE_OWNED_CLUSTER' });
    }
    complete(cfg, new Date('2026-10-17T00:00:00Z'));
    expect(cfg).toEqual({
      grants: { future_grant: true, owned_cluster: false, clusters: ['someone-elses-cluster'] },
      onboarding: {
        future_marker: 'keep',
        completed_at: '2026-10-15T00:00:00+00:00',
        rc_repro_version: expect.any(String),
      },
    });
  });

  it('never treats a non-mapping legacy value as a grant or replaces it on write', () => {
    const cfg: Config = { grants: ['owned-cluster'], onboarding: { untouched: true } };

    expect(heldGrants(cfg)).toEqual([]);
    expect(answeredGrants(cfg)).toEqual([]);
    expect(() => grant(cfg, 'owned-cluster', WHEN)).toThrow(ValidationError);
    expect(cfg).toEqual({ grants: ['owned-cluster'], onboarding: { untouched: true } });
  });

  it('refuses an undeclared grant before a command can write it', () => {
    expect(() => checkGrantId('unapproved-cluster')).toThrow(ValidationError);
    expect(grantIds()).toEqual(['owned-cluster']);
  });
});
