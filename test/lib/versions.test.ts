import { ValidationError } from '../../src/lib/errors';
import type { ReleaseInfoResponse, Resolved } from '../../src/lib/versions';
import {
  BUILD_TAG_RE,
  InvalidVersionError,
  MONGO_TAG_RE,
  NOT_A_RELEASE,
  baseVersion,
  buildPackageUrl,
  lookupUrl,
  applyMongoOverride,
  flavor,
  isValidVersion,
  mongoNote,
  requireValidMongoTag,
  resolve,
  resolveOnline,
  seriesTag,
  shell,
} from '../../src/lib/versions';

function reply(status: number, body: unknown): ReleaseInfoResponse {
  return { status, json: () => body };
}

describe('the shipped fallback map', () => {
  it.each([
    ['8.5.1', '8.0', 'official', 'mongosh', false],
    ['8.2.0', '8.0', 'official', 'mongosh', false],
    ['8.1.0', '8.2', 'official', 'mongosh', false],
    ['8.0.0', '8.2', 'official', 'mongosh', false],
    ['7.6.0', '7.0', 'bitnami-legacy', 'mongosh', true],
    ['6.5.3', '6.0', 'bitnami-legacy', 'mongosh', true],
    ['5.4.0', '5.0', 'bitnami-legacy', 'mongosh', true],
    ['4.8.7', '4.4', 'bitnami-legacy', 'mongo', true],
    ['3.18.7', '4.0', 'bitnami-legacy', 'mongo', true],
    ['2.4.14', '3.6', 'bitnami-legacy', 'mongo', true],
  ])('pairs RC %s with Mongo %s (%s/%s, oplog=%s)', (rc, mongo, fl, sh, oplog) => {
    const got = resolve(rc, { offline: true });
    expect(got.mongoTag).toBe(mongo);
    expect(got.mongoFlavor).toBe(fl);
    expect(got.mongoShell).toBe(sh);
    expect(got.oplog).toBe(oplog);
    expect(got.source).toBe('map (fallback)');
  });

  it('derives flavor and shell from the MONGO major, not the RC one', () => {
    // One rule (the MongoDB tag) to maintain, not four.
    expect(flavor('8.0')).toBe('official');
    expect(flavor('7.0')).toBe('bitnami-legacy');
    expect(shell('5.0')).toBe('mongosh');
    expect(shell('4.4')).toBe('mongo');
    // A tag that is not a number at all must not read as Mongo 8+.
    expect(flavor('latest')).toBe('bitnami-legacy');
    expect(shell('latest')).toBe('mongo');
  });

  it('gives RC 7.13 the MongoDB it gets online, and 7.12 what it always had', () => {
    // releases.rocket.chat lists 5/6/7/8 for every 7.13.x and 5.0/6.0/7.0 for 7.12 and
    // earlier. The map's one rule for all of 7.x gave 7.13 MongoDB 7.0 offline and 8.0
    // online: the same version, a different database, depending on the network.
    const online = resolve('7.13.2', {
      fetcher: () => reply(200, { compatibleMongoVersions: ['5', '6', '7', '8'] }),
    });
    const offline = resolve('7.13.2', { offline: true });
    expect([offline.mongoTag, offline.mongoFlavor, offline.oplog]).toEqual([
      online.mongoTag,
      online.mongoFlavor,
      online.oplog,
    ]);
    expect(offline.mongoTag).toBe('8.0');
    expect(resolve('7.12.0', { offline: true }).mongoTag).toBe('7.0');
  });

  it('emits the oplog for RC < 8 only', () => {
    expect(resolve('7.99.99', { offline: true }).oplog).toBe(true);
    expect(resolve('8.0.0', { offline: true }).oplog).toBe(false);
  });
});

describe('8.0rc1', () => {
  it('matches no rule and RAISES, which is behaviour and not a gap', () => {
    // A pre-release sorts below its release so `>=8.0.0` fails, and the specifier standard forbids
    // `<8.0.0` from admitting a pre-release of 8.0.0. That is kept on purpose: a
    // version nobody released must not resolve to a confident pairing.
    expect(() => resolve('8.0rc1', { offline: true })).toThrow(/no rule matches RC 8\.0rc1/);
  });

  it('while its near neighbours resolve, so the distinction is real', () => {
    expect(resolve('8.1.0rc2', { offline: true }).mongoTag).toBe('8.2');
    expect(resolve('2.0rc1', { offline: true }).mongoTag).toBe('3.6');
    expect(resolve('8.5.1-rc.1', { offline: true }).mongoTag).toBe('8.0');
  });
});

describe('an unparseable version', () => {
  it('is refused rather than resolved', () => {
    expect(() => resolve('7.0.0-develop', { offline: true })).toThrow(/not a valid version/);
    expect(() => resolve('latest', { offline: true })).toThrow(/not a valid version/);
  });
});

describe('MONGO_TAG_RE', () => {
  it.each([['8.0'], ['7.0.14'], ['8.0.4-ubi8'], ['_x'], ['A1']])('accepts %p', (tag) => {
    expect(() => requireValidMongoTag(tag)).not.toThrow();
  });

  it.each([
    ['', 'empty'],
    ['-8.0', 'leading dash'],
    ['.8.0', 'leading dot'],
    ['8.0 ', 'trailing space'],
    ['8.0;rm -rf /', 'a shell fragment'],
  ])('refuses %p (%s)', (tag) => {
    expect(() => requireValidMongoTag(tag)).toThrow(ValidationError);
  });

  it('refuses a TRAILING NEWLINE, which is the whole reason the anchor is spelled out', () => {
    // The Kubernetes Mongo manifest is built by interpolation, so a tag carrying a
    // newline was substituted verbatim and produced VALID YAML that kubectl accepts --
    // rendering a privileged container with host PID. Earlier releases' `$` matched before a
    // trailing newline and let it through; an end-of-text anchor was the fix there.
    expect(() => requireValidMongoTag('8.0\n')).toThrow(ValidationError);
    expect(MONGO_TAG_RE.test('8.0\n')).toBe(false);
    expect(MONGO_TAG_RE.test('8.0\n        securityContext:\n          privileged: true')).toBe(
      false,
    );
  });

  it('refuses a tag longer than an OCI tag may be', () => {
    expect(() => requireValidMongoTag(`8${'.0'.repeat(100)}`)).toThrow(ValidationError);
  });
});

describe('applyMongoOverride', () => {
  it('re-derives flavor and shell from the new tag', () => {
    const got = resolve('8.5.1', { offline: true });
    applyMongoOverride(got, '4.4');
    expect(got.mongoTag).toBe('4.4');
    expect(got.mongoFlavor).toBe('bitnami-legacy');
    expect(got.mongoShell).toBe('mongo');
  });

  it('validates at the one place a caller-supplied tag enters', () => {
    const got = resolve('8.5.1', { offline: true });
    expect(() => applyMongoOverride(got, '8.0\n')).toThrow(ValidationError);
    // ...and leaves the Resolved untouched when it refuses.
    expect(got.mongoTag).toBe('8.0');
  });
});

describe('seriesTag', () => {
  it('expands a bare major to the GA series the registry publishes', () => {
    // RC 7.13.x answers ["5","6","7","8"], and mongodb-community-server publishes only
    // <major>.<minor>: `8-ubi8` is a 404 and every boot died on "failed to resolve
    // reference".
    expect(seriesTag('8')).toBe('8.0');
    expect(seriesTag('7')).toBe('7.0');
  });

  it('leaves anything that already carries a minor alone', () => {
    expect(seriesTag('8.0')).toBe('8.0');
    expect(seriesTag('8.0.4')).toBe('8.0.4');
  });

  it('is null for anything it cannot read, so the caller falls back to the map', () => {
    expect(seriesTag('latest')).toBeNull();
    expect(seriesTag('8.x')).toBeNull();
    expect(seriesTag('')).toBeNull();
  });
});

describe('the live lookup', () => {
  it('takes the NEWEST compatible MongoDB and says so', () => {
    const got = resolveOnline('4.8.7', 4, () =>
      reply(200, { compatibleMongoVersions: ['3.6', '4.0', '4.2', '4.4', '5.0'] }),
    ) as Resolved;
    expect(got.mongoTag).toBe('5.0');
    expect(got.source).toBe('releases.rocket.chat');
    // WHICH END WAS TAKEN, SAID OUT LOUD: for a support reproduction the interesting
    // MongoDB is usually the customer's, which for an older RC is usually the oldest.
    expect(got.note).toContain('took the NEWEST, 5.0');
    expect(got.note).toContain('the oldest supported is 3.6');
    expect(got.note).toContain('--mongo <tag>');
  });

  it('expands a bare major and explains the substitution', () => {
    const got = resolveOnline('7.13.1', 7, () =>
      reply(200, { compatibleMongoVersions: ['5', '6', '7', '8'] }),
    ) as Resolved;
    expect(got.mongoTag).toBe('8.0');
    expect(got.note).toContain('bare major "8" -> 8.0');
  });

  it('falls back rather than guessing when the answer is not a version', () => {
    expect(
      resolveOnline('8.5.1', 8, () => reply(200, { compatibleMongoVersions: ['latest'] })),
    ).toBeNull();
  });

  it('falls back when the field is absent, as old releases leave it', () => {
    expect(resolveOnline('2.4.14', 2, () => reply(200, {}))).toBeNull();
  });

  it('distinguishes "could not ask" from "said no such release"', () => {
    // Both returned null before, so `houston versions 99.99.99` fell through to the
    // curated map and exited 0 with a confident pairing for a release that does not
    // exist.
    const why: string[] = [];
    expect(resolveOnline('99.99.99', 99, () => reply(404, {}), why)).toBeNull();
    expect(why).toEqual([NOT_A_RELEASE]);

    const silent: string[] = [];
    expect(
      resolveOnline(
        '99.99.99',
        99,
        () => {
          throw new Error('ECONNREFUSED');
        },
        silent,
      ),
    ).toBeNull();
    expect(silent).toEqual([]);
  });

  it('says so in the note when the endpoint answered 404', () => {
    const got = resolve('8.5.2', { fetcher: () => reply(404, {}) });
    expect(got.source).toBe('map (no such release)');
    expect(got.note).toContain('releases.rocket.chat has no 8.5.2');
    expect(got.note).toContain('typo');
    // ...and the series rule's own note is kept, not replaced.
    expect(got.note).toContain('MongoDB 8.0');
  });

  it('is not attempted at all when offline is set', () => {
    const fetcher = jest.fn(() => reply(200, { compatibleMongoVersions: ['8.0'] }));
    resolve('8.5.1', { offline: true, fetcher });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('takes the live answer over the map when it works', () => {
    const got = resolve('7.6.0', {
      fetcher: () => reply(200, { compatibleMongoVersions: ['5.0', '6.0', '7.0'] }),
    });
    expect(got.source).toBe('releases.rocket.chat');
    expect(got.mongoTag).toBe('7.0');
    expect(got.rcImage).toBe('registry.rocket.chat/rocketchat/rocket.chat');
  });
});

describe('mongoNote', () => {
  it('says nothing about ends when there is only one option', () => {
    expect(mongoNote('8.0', ['8.0'], '8.0')).toBe('compatibleMongoVersions=8.0');
  });
});

describe('isValidVersion', () => {
  it('is the check resolve makes first, so a caller can refuse before fetching', () => {
    expect(isValidVersion('8.5.1')).toBe(true);
    expect(isValidVersion('7.10.13')).toBe(true);
    for (const bad of ['nonsense', '', '8.5.1/../../x', 'latest']) {
      expect({ bad, valid: isValidVersion(bad) }).toEqual({ bad, valid: false });
      // ...and resolve refuses exactly the strings this rejects.
      expect(() => resolve(bad, { offline: true })).toThrow('is not a valid version');
    }
  });
});

describe('resolve, with the live answer stubbed', () => {
  // Earlier releases' spec stubs their HTTP get; this one hands `resolve` a fetcher, because the
  // suite refuses any fetch to a non-loopback host.
  const answering = (compatible: string[]) => (): ReleaseInfoResponse =>
    reply(200, { compatibleMongoVersions: compatible });

  it('turns a bare major into the .0 series the registry publishes, and says so', () => {
    // RC 7.13.6 answers ['5','6','7','8']; used verbatim that named
    // `mongodb-community-server:8-ubi8`, which is a 404, and every `up` died.
    const got = resolve('7.13.6', { fetcher: answering(['5', '6', '7', '8']) });
    expect(got.mongoTag).toBe('8.0');
    expect(got.source).toBe('releases.rocket.chat');
    expect([got.mongoFlavor, got.mongoShell]).toEqual(['official', 'mongosh']);
    expect(got.note).toContain('bare major');
    expect(got.note).toContain('8.0');
  });

  it('leaves an already-dotted answer exactly as it is', () => {
    // 8.2 is a real series; turning it into 8.0 would silently downgrade the pairing.
    expect(resolve('8.0.1', { fetcher: answering(['8.2']) }).mongoTag).toBe('8.2');
    expect(resolve('7.12.0', { fetcher: answering(['5.0', '6.0', '7.0']) }).mongoTag).toBe('7.0');
    expect(resolve('8.5.1', { fetcher: answering(['8.0.4']) }).mongoTag).toBe('8.0.4');
  });

  it('still takes the highest compatible version, normalising only its spelling', () => {
    expect(resolve('7.13.6', { fetcher: answering(['5', '8', '6']) }).mongoTag).toBe('8.0');
    expect(resolve('7.0.0', { fetcher: answering(['6.0', '5.0']) }).mongoTag).toBe('6.0');
  });

  it('falls back to the map for an answer that parses but is not a tag', () => {
    // `8.0rc1` is a valid version under the specifier standard and a tag nobody publishes.
    const got = resolve('7.13.6', { fetcher: answering(['8.0rc1']) });
    expect(got.source).toBe('map (fallback)');
    // The map's own answer for 7.13, which matches what a valid answer would have given.
    expect(got.mongoTag).toBe('8.0');
  });

  it('falls back to the map when the answer lists no versions', () => {
    expect(resolve('7.13.6', { fetcher: answering([]) }).source).toBe('map (fallback)');
  });

  it('names a never-released version online, and claims nothing offline', () => {
    // A 404 used to fall through to the map and exit 0 with a confident pairing for a
    // release that does not exist. An offline resolve cannot have asked, so it must not
    // claim the release is absent.
    const online = resolve('99.99.99', { fetcher: () => reply(404, {}) });
    expect(online.mongoTag).not.toBe('');
    expect(online.source).toBe('map (no such release)');
    expect(online.note).toContain('has no 99.99.99');
    const offline = resolve('99.99.99', { offline: true });
    expect(offline.source).toBe('map (fallback)');
    expect(offline.note).not.toContain('has no');
  });
});

describe('the offline pairings earlier releases’ spec names', () => {
  it('pairs RC 8.4.1, 7.10.13 and 4.8.0 by the three rule families', () => {
    const rc8 = resolve('8.4.1', { offline: true });
    expect([rc8.mongoFlavor, rc8.mongoShell, rc8.oplog]).toEqual(['official', 'mongosh', false]);
    expect(rc8.rcImage.endsWith('rocketchat/rocket.chat')).toBe(true);
    const rc7 = resolve('7.10.13', { offline: true });
    expect([rc7.mongoFlavor, rc7.oplog]).toEqual(['bitnami-legacy', true]);
    // mongosh only ships in Mongo 5+.
    const rc4 = resolve('4.8.0', { offline: true });
    expect([rc4.mongoTag, rc4.mongoShell]).toEqual(['4.4', 'mongo']);
  });
});

describe('a --mongo override', () => {
  it('must be an image tag, and a refused one is not applied', () => {
    // `--mongo` is templated into a StatefulSet, so a value carrying a newline added its
    // own YAML keys and `kubectl apply` accepted them. Refused at the boundary.
    const got = resolve('7.4.1', { offline: true });
    got.mongoTag = '7.0';
    for (const bad of [
      '8.0\n        privileged: true',
      '8.0 --privileged',
      '-8.0',
      '',
      'a'.repeat(129),
      '8.0\n',
    ]) {
      expect(() => applyMongoOverride(got, bad)).toThrow('not a MongoDB image tag');
    }
    expect(got.mongoTag).toBe('7.0');
    // The tags this tool actually pairs, including the flavor split at Mongo 8.
    applyMongoOverride(got, '8.0');
    expect([got.mongoTag, got.mongoFlavor]).toEqual(['8.0', 'official']);
    applyMongoOverride(got, '6.0.5-ubi8');
    expect([got.mongoTag, got.mongoFlavor]).toEqual(['6.0.5-ubi8', 'bitnami-legacy']);
  });
});

describe('a CI build as --version', () => {
  const DEVELOP_PKG =
    'https://raw.githubusercontent.com/RocketChat/Rocket.Chat/develop/apps/meteor/package.json';

  it('accepts the tags ghcr publishes and nothing else', () => {
    const ok = [
      'develop',
      'develop-fips',
      'develop-cov',
      'pr-42617',
      'pr-1-cov',
      'pr-42617-fips-gha-run-37666165904',
      'develop-gha-run-1',
    ];
    const refused = [
      'pr-0',
      'pr-',
      'pr-x',
      'develop-amd64',
      'develop-fips-cov',
      'Develop',
      '8.5.1',
      'pr-42617\n',
      'latest',
    ];
    expect(ok.filter((tag) => !BUILD_TAG_RE.test(tag))).toEqual([]);
    expect(refused.filter((tag) => BUILD_TAG_RE.test(tag))).toEqual([]);
  });

  it("reads the version from the branch's package.json", () => {
    expect(buildPackageUrl('develop-fips')).toBe(DEVELOP_PKG);
    expect(buildPackageUrl('pr-42617-cov-gha-run-9')).toBe(
      'https://raw.githubusercontent.com/RocketChat/Rocket.Chat/refs/pull/42617/head/apps/meteor/package.json',
    );
    expect([lookupUrl('develop'), lookupUrl('8.10.0.dev0'), lookupUrl('nope')]).toEqual([
      DEVELOP_PKG,
      null,
      null,
    ]);
    expect(lookupUrl('8.5.1')).toBe('https://releases.rocket.chat/8.5.1/info');
  });

  it('records a version both readers order: -develop becomes .dev0', () => {
    expect([
      baseVersion('8.10.0-develop'),
      baseVersion('8.10.0'),
      baseVersion('8.10.0-rc.1'),
    ]).toEqual(['8.10.0.dev0', '8.10.0', '8.10.0-rc.1']);
  });

  it('resolves to the build image, a real version, and the MongoDB of its release', () => {
    const asked: string[] = [];
    const got = resolve('pr-42617-fips', {
      fetcher: (url) => {
        asked.push(url);
        return reply(200, { name: '@rocket.chat/meteor', version: '8.10.0-develop' });
      },
    });
    expect(asked).toEqual([buildPackageUrl('pr-42617')]);
    expect(got).toMatchObject({
      rcVersion: '8.10.0.dev0',
      rcImage: 'ghcr.io/rocketchat/rocket.chat:pr-42617-fips',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      oplog: false,
      source: 'ci build',
    });
  });

  it('refuses offline, an unknown build and an unreadable answer, naming the URL and the way round', () => {
    const refusal = (fn: () => unknown): string => {
      try {
        fn();
      } catch (error) {
        if (error instanceof InvalidVersionError) return error.message;
        throw error;
      }
      return 'resolved';
    };
    const offline = refusal(() => resolve('develop', { offline: true }));
    const missing = refusal(() => resolve('pr-999999', { fetcher: () => reply(404, {}) }));
    const garbage = refusal(() =>
      resolve('develop', { fetcher: () => reply(200, { version: 'x' }) }),
    );
    const silent = refusal(() => resolve('develop', { fetcher: () => null }));
    expect(offline).toContain('needs the network');
    expect(missing).toContain('answered 404');
    expect(garbage).toContain('held no readable version');
    expect(silent).toContain('did not answer');
    for (const message of [offline, missing, garbage, silent]) {
      expect(message).toContain('--rc-image ghcr.io/rocketchat/rocket.chat:');
    }
  });

  it("pairs a recorded build's .dev0 as its release, offline, for a re-up or a restore", () => {
    expect(resolve('8.10.0.dev0', { offline: true })).toMatchObject({
      mongoTag: '8.0',
      source: 'map (fallback)',
    });
    // A pre-release still matches no rule, as it always has.
    expect(() => resolve('8.0rc1', { offline: true })).toThrow(InvalidVersionError);
  });
});
