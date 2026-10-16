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
        completed_by: 'person',
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
        completed_by: 'person',
        rc_repro_version: expect.any(String),
      },
    });
  });

  it('records who completed onboarding, gates on a person only, and never downgrades one', () => {
    const cfg: Config = {};
    complete(cfg, WHEN, 'defaults');
    expect(state(cfg)).toMatchObject({
      completed: true,
      completed_at: '2026-10-15T00:00:00+00:00',
      completed_by: 'defaults',
    });
    expect(() => requireOnboarded(cfg)).toThrow(AuthorityGateError);
    complete(cfg, new Date('2026-10-16T00:00:00Z'), 'person');
    expect(state(cfg)).toMatchObject({
      completed_at: '2026-10-16T00:00:00+00:00',
      completed_by: 'person',
    });
    expect(() => requireOnboarded(cfg)).not.toThrow();
    complete(cfg, new Date('2026-10-17T00:00:00Z'), 'defaults');
    expect(state(cfg)).toMatchObject({
      completed_at: '2026-10-16T00:00:00+00:00',
      completed_by: 'person',
    });
  });

  it.each([
    [
      'a record written before completed_by existed',
      { completed_at: '2026-10-15T00:00:00Z' },
      true,
    ],
    [
      'an unrecognised completed_by',
      { completed_at: '2026-10-15T00:00:00Z', completed_by: 'x' },
      false,
    ],
  ])('reads %s as a person only when it is legacy', (_label, onboarding, person) => {
    const cfg: Config = { onboarding };
    expect(state(cfg).completed).toBe(true);
    expect(state(cfg).completed_by).toBe(person ? 'person' : 'defaults');
    if (person) expect(() => requireOnboarded(cfg)).not.toThrow();
    else expect(() => requireOnboarded(cfg)).toThrow(AuthorityGateError);
  });

  it('never treats a non-mapping legacy value as a grant or replaces it on write', () => {
    const cfg: Config = { grants: ['owned-cluster'], onboarding: { untouched: true } };

    expect(heldGrants(cfg)).toEqual([]);
    expect(answeredGrants(cfg)).toEqual([]);
    expect(() => grant(cfg, 'owned-cluster', WHEN)).toThrow(ValidationError);
    expect(cfg).toEqual({ grants: ['owned-cluster'], onboarding: { untouched: true } });
  });

  it.each([
    ['string', 'yes'],
    ['null', null],
    ['number', 1],
  ])('treats a malformed %s grant value as unanswered', (_kind, value) => {
    const cfg: Config = { grants: { owned_cluster: value } };

    expect(holdsGrant('owned-cluster', cfg)).toBe(false);
    expect(answeredGrants(cfg)).toEqual([]);
    expect(state(cfg)).toMatchObject({
      grants: { owned_cluster: false },
      answered_grants: { owned_cluster: false },
      grants_available: [{ id: 'owned-cluster', held: false, answered: false }],
    });
  });

  it('refuses an undeclared grant before a command can write it', () => {
    expect(() => checkGrantId('unapproved-cluster')).toThrow(ValidationError);
    expect(grantIds()).toEqual(['owned-cluster']);
  });
});
