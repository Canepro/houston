import { createApp } from '../../../src/web/app';

describe('request validation at the Fastify boundary, answered as earlier releases did', () => {
  it('returns 422 for missing, null, non-dictionary, malformed, and unsupported bodies', async () => {
    const app = await createApp({ accounts: false });
    try {
      const missing = await app.inject({ method: 'POST', url: '/api/users' });
      expect(missing.statusCode).toBe(422);
      expect(missing.json().detail[0]).toEqual(
        expect.objectContaining({ type: 'missing', loc: ['body'] }),
      );

      const explicitNull = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { 'content-type': 'application/json' },
        payload: 'null',
      });
      expect(explicitNull.statusCode).toBe(422);
      expect(explicitNull.json().detail[0].type).toBe('missing');

      const array = await app.inject({ method: 'POST', url: '/api/users', payload: [] });
      expect(array.statusCode).toBe(422);
      expect(array.json().detail[0].type).toBe('dict_type');

      const malformed = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { 'content-type': 'application/json' },
        payload: '{',
      });
      expect(malformed.statusCode).toBe(422);
      expect(malformed.json().detail[0].type).toBe('json_invalid');
      expect(malformed.json().detail[0].loc).toEqual(['body', 1]);
      expect(malformed.json().detail[0].ctx.error).toBe(
        'Expecting property name enclosed in double quotes',
      );

      const incompleteArray = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { 'content-type': 'application/json' },
        payload: '[',
      });
      expect(incompleteArray.statusCode).toBe(422);
      expect(incompleteArray.json().detail[0]).toEqual(
        expect.objectContaining({
          type: 'json_invalid',
          loc: ['body', 1],
          ctx: { error: 'Expecting value' },
        }),
      );

      for (const [payload, position, error] of [
        ['{"a"', 4, "Expecting ':' delimiter"],
        ['{"a":', 5, 'Expecting value'],
        ['{"a":1', 6, "Expecting ',' delimiter"],
        ['[1', 2, "Expecting ',' delimiter"],
        ['x', 0, 'Expecting value'],
        ['1 2', 2, 'Extra data'],
        ['{"a":}', 5, 'Expecting value'],
        ['[1,]', 3, 'Expecting value'],
        ['{"a":1,}', 7, 'Expecting property name enclosed in double quotes'],
        ['"abc', 0, 'Unterminated string starting at'],
        ['"a\\q"', 2, 'Invalid \\escape'],
        ['"a\nb"', 2, 'Invalid control character at'],
        ['"a\\', 0, 'Unterminated string starting at'],
        ['"\\u12"', 2, 'Invalid \\uXXXX escape'],
        ['{"a":01}', 6, "Expecting ',' delimiter"],
        ['[1,,2]', 3, 'Expecting value'],
        ['"😀" x', 4, 'Extra data'],
        ['\uFEFF{}', 0, 'Unexpected UTF-8 BOM'],
      ] as const) {
        const invalid = await app.inject({
          method: 'POST',
          url: '/api/users',
          headers: { 'content-type': 'application/json' },
          payload,
        });
        expect(invalid.statusCode).toBe(422);
        expect(invalid.json().detail[0]).toEqual(
          expect.objectContaining({
            type: 'json_invalid',
            loc: ['body', position],
            ctx: { error },
          }),
        );
      }

      const unsupported = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { 'content-type': 'application/octet-stream' },
        payload: '{}',
      });
      expect(unsupported.statusCode).toBe(422);
      expect(unsupported.json().detail[0].type).toBe('dict_type');
      expect(unsupported.json().detail[0].input).toBe('{}');

      const form = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'name=bob',
      });
      expect(form.statusCode).toBe(422);
      expect(form.json().detail[0].type).toBe('dict_type');
    } finally {
      await app.close();
    }
  });

  it('accepts the frozen UI empty form logout while rejecting forms for dictionary bodies', async () => {
    const app = await createApp({ accounts: false });
    try {
      const signout = await app.inject({
        method: 'POST',
        url: '/signout',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });
      expect(signout.statusCode).toBe(303);
      expect(signout.headers.location).toBe('/signin?e=signedout');

      const dictionary = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'name=bob',
      });
      expect(dictionary.statusCode).toBe(422);
      expect(dictionary.json().detail[0].type).toBe('dict_type');
      expect(dictionary.json().detail[0].input).toBe('name=bob');

      const optionalEmpty = await app.inject({
        method: 'POST',
        url: '/api/session',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });
      expect(optionalEmpty.statusCode).not.toBe(422);

      const requiredEmpty = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });
      expect(requiredEmpty.statusCode).toBe(422);
      expect(requiredEmpty.json().detail[0]).toEqual(
        expect.objectContaining({ type: 'missing', input: null }),
      );
    } finally {
      await app.close();
    }
  });

  it('authorises protected routes before parsing or validating their bodies', async () => {
    const app = await createApp({ accounts: true });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { 'content-type': 'application/json' },
        payload: '{',
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'sign in to use houston', kind: 'Unauthorized' });
    } finally {
      await app.close();
    }
  });

  it('validates default dictionary bodies before resolving route targets', async () => {
    const app = await createApp({ accounts: false });
    try {
      for (const url of [
        '/api/repros/definitely-missing/loadtest',
        '/api/repros/definitely-missing/capacity',
        '/api/repros/definitely-missing/config-import',
      ]) {
        const response = await app.inject({ method: 'POST', url, payload: [] });
        expect(response.statusCode).toBe(422);
        expect(response.json().detail[0].type).toBe('dict_type');
      }
    } finally {
      await app.close();
    }
  });

  it('treats empty and null default bodies as the declared empty dictionary', async () => {
    const app = await createApp({ accounts: false });
    try {
      const empty = await app.inject({
        method: 'POST',
        url: '/api/session',
        headers: { 'content-type': 'application/json' },
        payload: '',
      });
      expect(empty.statusCode).not.toBe(422);

      const explicitNull = await app.inject({
        method: 'POST',
        url: '/api/session',
        headers: { 'content-type': 'application/json' },
        payload: 'null',
      });
      expect(explicitNull.statusCode).not.toBe(422);
    } finally {
      await app.close();
    }
  });

  it('validates typed and required query values and takes the final repeated scalar', async () => {
    const app = await createApp({ accounts: false });
    try {
      const invalidInt = await app.inject({ method: 'GET', url: '/api/audit?limit=nope' });
      expect(invalidInt.statusCode).toBe(422);
      expect(invalidInt.json().detail[0]).toEqual(
        expect.objectContaining({ type: 'int_parsing', loc: ['query', 'limit'] }),
      );

      const finalInt = await app.inject({ method: 'GET', url: '/api/audit?limit=nope&limit=2' });
      expect(finalInt.statusCode).toBe(200);

      const invalidBool = await app.inject({
        method: 'GET',
        url: '/api/versions/8.5.1?offline=%20true%20',
      });
      expect(invalidBool.statusCode).toBe(422);
      expect(invalidBool.json().detail[0]).toEqual(
        expect.objectContaining({ type: 'bool_parsing', loc: ['query', 'offline'] }),
      );

      const missingPath = await app.inject({ method: 'DELETE', url: '/api/backups' });
      expect(missingPath.statusCode).toBe(422);
      expect(missingPath.json().detail[0]).toEqual(
        expect.objectContaining({ type: 'missing', loc: ['query', 'path'] }),
      );
    } finally {
      await app.close();
    }
  });
});
