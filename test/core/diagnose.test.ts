import * as fs from 'node:fs';
import * as path from 'node:path';

import { SIGNATURE_COUNT, match, signatures } from '../../src/core/diagnose';

import type * as DiagnoseNS from '../../src/core/diagnose';

/**
 * What earlier releases answered, recorded: their signature table (needles and hint, in
 * order) and their `match` of each text the second test below asks about.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'core', 'diagnose.json'), 'utf8'),
) as { signatures: [string[], string][]; matches: (string | null)[] };

/**
 * Real fragments of the output each failure actually produces, not invented strings.
 *
 * A signature table tested only against its own needles proves the needles are spelled
 * consistently and nothing else. These are the shapes that arrived in the reports the
 * table was written from.
 */
const SAMPLES: [string, string][] = [
  [
    'hub rate limit',
    'Error response from daemon: toomanyrequests: You have reached your pull rate limit.',
  ],
  [
    'mongo kernel abort',
    'MongoDB 8.0 detected incompatibility with this version of MongoDB on kernel versions 6.19',
  ],
  ['wrong arch', 'no matching manifest for linux/arm64/v8 in the manifest list entries'],
  ['replica set never came up', 'MongoServerSelectionError: ReplicaSetNoPrimary'],
  ['bad tag', 'manifest unknown: manifest unknown'],
  ['private image', 'unauthorized: authentication required'],
  ['low port on rootless', 'rootlessport cannot expose privileged port 80'],
  ['full disk', 'write /var/lib/docker: no space left on device'],
];

describe('signature matching', () => {
  it.each(SAMPLES)('recognises %s', (_label, text) => {
    expect(match(text)).not.toBeNull();
  });

  it('answers null for output it does not recognise', () => {
    expect(match('')).toBeNull();
    expect(match('everything is fine')).toBeNull();
  });

  it('is case-insensitive, because docker and mongod disagree about case', () => {
    expect(match('TOOMANYREQUESTS')).toBe(match('toomanyrequests'));
    expect(match('No Space Left On Device')).not.toBeNull();
  });

  it('returns the FIRST match, so the most specific signature wins', () => {
    // A Hub rate-limit reply also contains the word "unauthorized" in some daemons. The
    // order of the table is what decides which hint a reader gets, and the rate-limit one
    // names the fix.
    const both = 'toomanyrequests ... unauthorized';
    expect(match(both)).toBe(match('toomanyrequests'));
    expect(match(both)).not.toBe(match('unauthorized'));
  });

  it('never returns an empty hint for a matched signature', () => {
    for (const [, hint] of signatures()) {
      expect(hint.length).toBeGreaterThan(40);
    }
  });
});

describe('the same table as earlier releases', () => {
  it('has the same signature groups, in the same order, with the same hints', () => {
    // The hint TEXT is the contract: it is what a support engineer reads at the moment a
    // boot failed, and a hint worded differently from the one earlier releases gave is two
    // answers to one ticket. Compared character for character rather than paraphrased.
    // Two groups are added: one appended, for `--license`, which earlier releases never had,
    // and one for a container a failed start left with no network, which has to come
    // BEFORE the replica set's -- its logs say "topology is closed" too, and first match
    // wins, so it was blamed on emulation on an x86_64 host.
    const expected = RECORDED.signatures;
    const mine = signatures().map(([needles, hint]) => [[...needles], hint]);
    const NETWORK = ['getaddrinfo eai_again mongodb', 'getaddrinfo enotfound mongodb'];
    const at = mine.findIndex(([needles]) => JSON.stringify(needles) === JSON.stringify(NETWORK));
    const replicaSet = mine.findIndex(([needles]) =>
      (needles as string[]).includes('topology is closed'),
    );
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(replicaSet);
    const theirs = mine.filter((_, index) => index !== at);
    expect(theirs.slice(0, expected.length)).toEqual(expected);
    expect(theirs.slice(expected.length).map(([needles]) => needles)).toEqual([
      ['invalidlicenseerror'],
    ]);
    expect(SIGNATURE_COUNT).toBe(expected.length + 2);
  });

  it('names a Rocket.Chat that lost its network, not the replica set', () => {
    // Logged by a container a failed start detached, alongside "Topology is closed".
    const logs =
      'MongoServerSelectionError: getaddrinfo EAI_AGAIN mongodb\n' +
      'MongoTopologyClosedError: Topology is closed';
    expect(match(logs)).toContain('has no network');
  });

  it('names a licence Rocket.Chat refused, from the line 8.5.1 logs', () => {
    const logs =
      '=== UnHandledPromiseRejection ===\nInvalidLicenseError: Invalid license\n' +
      '    at validateFormat (/app/bundle/programs/server/npm/node_modules/@rocket.chat/license/dist/validation/validateFormat.js:14:15)';
    expect(match(logs)).toContain('refused the licence given with --license');
  });

  it('answers identically for every sample, including the ones it does not know', () => {
    const texts = [...SAMPLES.map(([, t]) => t), '', 'everything is fine', 'TOOMANYREQUESTS'];
    expect(RECORDED.matches).toHaveLength(texts.length);
    expect(texts.map(match)).toEqual(RECORDED.matches);
  });
});

describe('the hint each failure gets', () => {
  it('sends a Hub rate limit to `docker login`', () => {
    const hint = match(
      'Error: unable to copy from source docker://registry.rocket.chat/...: ' +
        'toomanyrequests: You have reached your unauthenticated pull rate limit.',
    );
    expect(hint).toContain('docker login');
    expect(hint?.toLowerCase()).toContain('rate limit');
  });

  it('names SERVER-121912 for the mongod kernel abort, and says it is NOT a volume fault', () => {
    const hint = match(
      '{"s":"F","c":"CONTROL","id":12257600,"ctx":"main","msg":"MongoDB cannot ' +
        'start: Linux kernel versions 6.19 and newer has a known incompatibility"}',
    );
    expect(hint).toContain('SERVER-121912');
    expect(hint).toContain('NOT a volume');
  });

  it('names the replica set when one was never initialised', () => {
    expect(
      match(
        'MongoServerError: NotYetInitialized: no replset config has been received',
      )?.toLowerCase(),
    ).toContain('replica set');
  });

  it('names the architecture for a platform mismatch', () => {
    expect(
      match('no matching manifest for linux/arm64/v8 in the manifest list entries')?.toLowerCase(),
    ).toContain('architecture');
  });

  it('reads the missing-tag message modern containerd actually prints', () => {
    expect(
      match(
        'Error response from daemon: failed to resolve reference ' +
          '"registry.rocket.chat/rocketchat/rocket.chat:0.0.0": not found',
      ),
    ).toContain('tag was not found');
  });

  it('covers a private image, a full disk and a privileged port', () => {
    expect(match('Error: authentication required') ?? '').toContain('login');
    expect((match('write /data: no space left on device') ?? '').toLowerCase()).toContain('disk');
    expect(
      match('rootlessport cannot expose privileged port 80, bind: permission denied') ?? '',
    ).toContain('1024');
  });

  it('answers null for a clean log and an empty one, whatever the case', () => {
    expect(match('TOOMANYREQUESTS')).not.toBeNull();
    expect(match('Container started; all healthy')).toBeNull();
    expect(match('')).toBeNull();
  });

  it('lets a rate limit beat the generic manifest error it also mentions', () => {
    expect(
      match(
        'reading manifest 8.6.1 in registry.rocket.chat/rocketchat/rocket.chat: ' +
          'toomanyrequests: You have reached your unauthenticated pull rate limit.',
      ),
    ).toContain('docker login');
  });
});

describe('diagnosing a failed up', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/runner/engine');
    jest.resetModules();
  });

  function withEvidence(
    logs: () => Promise<string>,
    pull: () => Promise<string>,
  ): typeof DiagnoseNS {
    jest.resetModules();
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      composeLogsCapture: logs,
      composePullCapture: pull,
    }));
    return require('../../src/core/diagnose') as typeof DiagnoseNS;
  }
  const never = (): Promise<string> => Promise.reject(new Error('must not pull when logs suffice'));

  it('reads the containers’ own logs first, and does not pull when they explain it', async () => {
    const diagnose = withEvidence(
      async () => 'F CONTROL SERVER-121912 kernel versions 6.19',
      never,
    );
    expect(await diagnose.diagnoseFailure('x')).toContain('SERVER-121912');
  });

  it('falls back to a pull when nothing started', async () => {
    const diagnose = withEvidence(
      async () => '',
      async () => 'toomanyrequests: unauthenticated pull rate limit',
    );
    expect(await diagnose.diagnoseFailure('x')).toContain('docker login');
  });

  it('answers null for logs it does not recognise, without pulling', async () => {
    let pulled = false;
    const diagnose = withEvidence(
      async () => 'normal startup lines',
      async () => {
        pulled = true;
        return '';
      },
    );
    expect(await diagnose.diagnoseFailure('x')).toBeNull();
    expect(pulled).toBe(false);
  });

  it('never throws, because a diagnosis that throws replaces the real error', async () => {
    const gone = (): Promise<string> => Promise.reject(new Error('docker gone'));
    const diagnose = withEvidence(gone, gone);
    expect(await diagnose.diagnoseFailure('x')).toBeNull();
  });
});
