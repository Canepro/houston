import { DEFAULT_DATABASE, databaseOf } from '../../src/core/database-of';
import * as compose from '../../src/lib/compose';
import { metadata, write } from '../../src/core/runner/record';

interface Case {
  name: string;
  environment?: unknown;
  services?: Record<string, unknown>;
  /** The database earlier releases answered for this document, recorded. */
  expected: string;
}

/**
 * The two edges `perf.mongoprof -> backup` and `scaleseed -> backup`, held to the answers
 * earlier releases gave.
 *
 * Earlier releases reached the backup module's lookup through a guarded deferred import,
 * whose failure branch answered the plain default. This build hoists the function into
 * `core/database-of.ts` — the layering rule's own remedy for something two lower modules
 * need — so what this compares is the REAL path: a MONGO_URL the workspace overrode, which
 * the plain default would answer wrongly.
 */
describe('the database a workspace actually uses', () => {
  const CASES: Case[] = [
    {
      name: 'map form, custom database',
      services: {
        rocketchat: {
          environment: { MONGO_URL: 'mongodb://mongodb:27017/customerdb?replicaSet=rs0' },
        },
      },
      expected: 'customerdb',
    },
    {
      name: 'list form, custom database',
      services: {
        rocketchat: { environment: ['MONGO_URL=mongodb://mongodb:27017/listdb', 'PORT=3000'] },
      },
      expected: 'listdb',
    },
    {
      name: 'no database in the URL',
      services: { rocketchat: { environment: { MONGO_URL: 'mongodb://mongodb:27017' } } },
      expected: 'rocketchat',
    },
    {
      name: 'no MONGO_URL at all',
      services: { rocketchat: { environment: { PORT: '3000' } } },
      expected: 'rocketchat',
    },
    {
      name: 'the first multi-instance service when rocketchat is absent',
      services: { 'rocketchat-1': { environment: { MONGO_URL: 'mongodb://x:27017/instdb' } } },
      expected: 'instdb',
    },
    {
      // An EMPTY primary service counts as absent and falls through to the instance.
      // `??` answered the default database for this document.
      name: 'an empty primary service falls through to the first instance',
      services: {
        rocketchat: {},
        'rocketchat-1': { environment: { MONGO_URL: 'mongodb://x:27017/instdb' } },
      },
      expected: 'instdb',
    },
    {
      // Everything after the FIRST scheme separator is the rest of the URL.
      // `split('://').at(-1)` took the text after the LAST one.
      name: 'a URL carrying two scheme separators',
      services: { rocketchat: { environment: { MONGO_URL: 'mongodb://a://b' } } },
      expected: '/b',
    },
    { name: 'no services key at all', services: {}, expected: 'rocketchat' },
  ];

  it('answers what earlier releases answered on every document shape', async () => {
    for (const [index, testCase] of CASES.entries()) {
      const name = `d${String(index)}`;
      const doc = { services: testCase.services ?? {}, volumes: {} };
      await write(
        name,
        compose.toYaml(doc as unknown as compose.ComposeDoc),
        metadata({ name, project: `houston-${name}` }),
      );
      expect(await databaseOf(name)).toBe(testCase.expected);
    }
    expect(await databaseOf('no-such-workspace')).toBe(DEFAULT_DATABASE);
  });

  it('is what the two former deferred-edge callers now address', async () => {
    // The consumers' own `dbOf` must answer the workspace's database, not the constant.
    const name = 'consumer';
    await write(
      name,
      compose.toYaml({
        services: { rocketchat: { environment: { MONGO_URL: 'mongodb://m:27017/realdb' } } },
        volumes: {},
      } as unknown as compose.ComposeDoc),
      metadata({ name, project: 'houston-consumer' }),
    );
    const scaleseed = require('../../src/core/scaleseed') as {
      dbOf: (n: string) => Promise<string>;
    };
    const mongoprof = require('../../src/perf/mongoprof') as {
      dbOf: (n: string) => Promise<string>;
    };
    expect(await scaleseed.dbOf(name)).toBe('realdb');
    expect(await mongoprof.dbOf(name)).toBe('realdb');
    // And the fallback is still distinguished: no record, no custom name.
    expect(await scaleseed.dbOf('no-such-workspace')).toBe(DEFAULT_DATABASE);
    expect(await mongoprof.dbOf('no-such-workspace')).toBe(DEFAULT_DATABASE);
  });
});
