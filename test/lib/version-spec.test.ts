import {
  InvalidSpecifier,
  InvalidVersion,
  SpecifierSet,
  compareVersions,
  highest,
  lowest,
  matches,
  parseVersion,
} from '../../src/lib/version-spec';

describe('parsing', () => {
  it.each([
    ['8.5.1', '8.5.1'],
    ['8.0', '8.0'],
    ['8', '8'],
    ['v8.5.1', '8.5.1'],
    ['  8.5.1  ', '8.5.1'],
    // A version accepts a trailing newline. This is exactly why `MONGO_TAG_RE` needs
    // its own stricter anchor: "8.0\n" is a valid VERSION and an invalid image TAG.
    ['8.0\n', '8.0'],
    ['8.5.1-rc.1', '8.5.1rc1'],
    ['8.5.1.rc1', '8.5.1rc1'],
    ['8.5.1_rc1', '8.5.1rc1'],
    ['8.5.1a1', '8.5.1a1'],
    ['8.5.1b2', '8.5.1b2'],
    ['8.0rc1', '8.0rc1'],
    ['8.5.1.post1', '8.5.1.post1'],
    ['8.5.1.dev0', '8.5.1.dev0'],
    ['8.5.1+local', '8.5.1+local'],
    ['1!2.0', '1!2.0'],
  ])('normalises %p to %p', (raw, normalised) => {
    expect(parseVersion(raw).text).toBe(normalised);
  });

  it.each([['7.0.0-develop'], ['not-a-version'], [''], ['8.5.1..2'], ['rc1']])(
    'throws InvalidVersion on %p',
    (raw) => {
      expect(() => parseVersion(raw)).toThrow(InvalidVersion);
    },
  );

  it('reports a pre-release and a dev release as pre-releases', () => {
    expect(parseVersion('8.0rc1').isPrerelease).toBe(true);
    expect(parseVersion('8.5.1.dev0').isPrerelease).toBe(true);
    expect(parseVersion('8.5.1').isPrerelease).toBe(false);
    expect(parseVersion('8.5.1.post1').isPrerelease).toBe(false);
  });
});

describe('ordering', () => {
  function lt(a: string, b: string): boolean {
    return compareVersions(parseVersion(a), parseVersion(b)) < 0;
  }

  it('treats trailing zeros as insignificant', () => {
    expect(compareVersions(parseVersion('8.0'), parseVersion('8.0.0'))).toBe(0);
    expect(compareVersions(parseVersion('8'), parseVersion('8.0.0'))).toBe(0);
  });

  it('sorts a pre-release BELOW its release', () => {
    // This one rule is why `8.0rc1` fails `>=8.0.0` and falls through to the next
    // versions.yaml rule.
    expect(lt('8.0rc1', '8.0.0')).toBe(true);
    expect(lt('8.5.1a1', '8.5.1b2')).toBe(true);
    expect(lt('8.5.1b2', '8.5.1rc1')).toBe(true);
    expect(lt('8.5.1rc1', '8.5.1')).toBe(true);
  });

  it('sorts dev below every pre-release, and post above the release', () => {
    expect(lt('8.5.1.dev0', '8.5.1a1')).toBe(true);
    expect(lt('8.5.1', '8.5.1.post1')).toBe(true);
  });

  /**
   * THE LOCAL LABEL IS ORDERED, and it is the one rule this implementation got wrong.
   * It started out ignoring the label -- which is correct for a SPECIFIER and wrong for
   * an ORDERING, two different rules in the specifier standard that are easy to conflate.
   * A comparison against earlier releases caught it on `8.5.1+local` against
   * `8.5.1+local.1`: they said -1 and this build said 0.
   */
  it('sorts a version with no local label BELOW one that has it', () => {
    expect(lt('8.5.1', '8.5.1+abc')).toBe(true);
  });

  it('sorts a shorter local label below a longer one sharing its prefix', () => {
    expect(lt('8.5.1+local', '8.5.1+local.1')).toBe(true);
  });

  it('compares a numeric local segment numerically, and above an alphanumeric one', () => {
    expect(lt('8.5.1+2', '8.5.1+10')).toBe(true);
    expect(lt('8.5.1+abc', '8.5.1+1')).toBe(true);
  });

  it('but a SPECIFIER ignores the local label entirely', () => {
    // The specifier standard: "local version labels MUST be ignored entirely when checking if candidate
    // versions match a given version specifier".
    expect(matches('8.5.1+abc', '>=8.5.1')).toBe(true);
    expect(matches('8.5.1+abc', '<8.5.1')).toBe(false);
    expect(matches('8.5.0+abc', '<8.5.1')).toBe(true);
  });

  it('orders by epoch first', () => {
    expect(lt('99.0', '1!1.0')).toBe(true);
  });
});

describe('specifiers', () => {
  it('handles the three shapes versions.yaml uses', () => {
    expect(matches('8.5.1', '>=8.2.0')).toBe(true);
    expect(matches('8.1.0', '>=8.0.0,<8.2.0')).toBe(true);
    expect(matches('2.9.9', '<3.0.0')).toBe(true);
  });

  it('THROWS rather than guessing on a shape it does not implement', () => {
    // "Throw on any form not implemented rather than silently mistranslating." A
    // plausible boolean for an unimplemented operator pairs the wrong MongoDB with a
    // customer's Rocket.Chat, which is the one job this tool has.
    for (const spec of ['==8.5.1', '!=8.5.1', '~=8.5.0', '>8.0.0', '<=8.0.0', '===8.5.1']) {
      expect(() => new SpecifierSet(spec)).toThrow(InvalidSpecifier);
    }
  });

  it('names the operator and says what to do about it', () => {
    expect(() => new SpecifierSet('~=8.5.0')).toThrow(/'~='/);
    expect(() => new SpecifierSet('~=8.5.0')).toThrow(/corpus row/);
  });

  it('treats comma as AND', () => {
    expect(matches('8.2.0', '>=8.0.0,<8.2.0')).toBe(false);
    expect(matches('8.1.9', '>=8.0.0,<8.2.0')).toBe(true);
  });

  it('contains everything when empty', () => {
    expect(new SpecifierSet('').contains(parseVersion('8.0rc1'))).toBe(true);
  });
});

describe('the two pre-release rules, which are the whole of the subtlety', () => {
  it('>=V rejects a pre-release of V because it sorts below', () => {
    expect(matches('8.0rc1', '>=8.0.0')).toBe(false);
    expect(matches('8.0rc1', '>=7.0.0')).toBe(true);
  });

  it('<V rejects a pre-release OF V, even though it sorts below', () => {
    // The specifier standard: "The exclusive ordered comparison <V MUST NOT allow a pre-release of the
    // specified version unless the specified version is itself a pre-release."
    expect(matches('8.0rc1', '<8.0.0')).toBe(false);
    expect(matches('3.0rc1', '<3.0.0')).toBe(false);
  });

  it('<V ADMITS a pre-release of some OTHER version', () => {
    expect(matches('8.1.0rc2', '<8.2.0')).toBe(true);
    expect(matches('2.0rc1', '<3.0.0')).toBe(true);
    expect(matches('7.9rc1', '<8.0.0')).toBe(true);
  });

  it('<V admits a pre-release of V when V is itself a pre-release', () => {
    expect(matches('8.0a1', '<8.0rc1')).toBe(true);
  });

  it('together, these make 8.0rc1 match NO rule in versions.yaml', () => {
    // This is BEHAVIOUR, not a bug to fix -- earlier releases do the same. 8.0rc1 fails >=8.0.0
    // (sorts below) and fails <8.0.0 (pre-release of the specified version), so it falls
    // off the end and `resolve` raises.
    const RULES = [
      '>=8.2.0',
      '>=8.0.0,<8.2.0',
      '>=7.0.0,<8.0.0',
      '>=6.0.0,<7.0.0',
      '>=5.0.0,<6.0.0',
      '>=4.0.0,<5.0.0',
      '>=3.0.0,<4.0.0',
      '<3.0.0',
    ];
    expect(RULES.filter((r) => matches('8.0rc1', r))).toEqual([]);
    // ...while its near neighbours do match, which is what makes it a real distinction
    // rather than blanket pre-release exclusion.
    expect(RULES.filter((r) => matches('8.1.0rc2', r))).toEqual(['>=8.0.0,<8.2.0']);
    expect(RULES.filter((r) => matches('2.0rc1', r))).toEqual(['<3.0.0']);
    expect(RULES.filter((r) => matches('8.5.1-rc.1', r))).toEqual(['>=8.2.0']);
  });
});

describe('highest and lowest', () => {
  it('pick the ends and skip what they cannot parse', () => {
    expect(highest(['5.0', '6.0', '7.0'])).toBe('7.0');
    expect(lowest(['5.0', '6.0', '7.0'])).toBe('5.0');
    expect(highest(['5.0', 'nonsense', '7.0'])).toBe('7.0');
    expect(highest([])).toBeNull();
    expect(lowest(['nonsense'])).toBeNull();
  });

  it('return the RAW string, not the normalised one', () => {
    // The value is used as a docker tag, so `8` must come back as `8` for `seriesTag` to
    // recognise the bare-major case.
    expect(highest(['5', '6', '7', '8'])).toBe('8');
  });
});

describe('lowest, as the compatible-Mongo note reads it', () => {
  it('names the oldest end, skipping what it cannot parse, and is null for nothing', () => {
    // The note says which end was taken because for an older RC the customer's MongoDB is
    // usually the OLDEST supported one, not the newest the resolver picks.
    expect(lowest(['3.6', '4.0', '4.4', '5.0'])).toBe('3.6');
    expect(highest(['3.6', '4.0', '4.4', '5.0'])).toBe('5.0');
    expect(lowest(['latest', '4.4'])).toBe('4.4');
    expect(lowest([])).toBeNull();
  });
});

describe("the whitespace around a version, as earlier releases' `\\s` reads it", () => {
  it('accepts what earlier releases call whitespace and refuses a BOM, as they do', () => {
    // Earlier releases' `\s` holds \x1c-\x1f and NEL and not the BOM; JavaScript's the
    // reverse, so `versions $'\x1c8.5.1'` resolved in earlier releases and was invalid here.
    // Held to the versions earlier releases parsed from the same texts, recorded.
    const texts = ['\u001c8.5.1', '8.5.1\u001f', '\u00858.5.1', '﻿8.5.1', '　8.5.1　'];
    texts.push('​8.5.1', '\t8.5.1\r\n', ' 8.5.1');
    // `null` where earlier releases refused the text as no version at all.
    const recorded = ['8.5.1', '8.5.1', '8.5.1', null, '8.5.1', null, '8.5.1', '8.5.1'];
    const ours = texts.map((text) => {
      try {
        return parseVersion(text).text;
      } catch (error) {
        if (error instanceof InvalidVersion) return null;
        throw error;
      }
    });
    expect(ours).toEqual(recorded);
  });
});
