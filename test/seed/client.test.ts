import type * as ClientNS from '../../src/seed/client';

type Bag = Record<string, unknown>;

function load(reply: (path: string, options: Bag) => [number, string, Record<string, string>?]) {
  jest.resetModules();
  const call = jest.fn((_root: string, _method: string, requestPath: string, options: Bag) => {
    const [status, text, headers = {}] = reply(requestPath, options);
    Object.assign(options.responseHeaders ?? {}, headers);
    return Promise.resolve([status, text]);
  });
  const multipart = jest.fn(() =>
    Promise.resolve([200, '{"success":true,"file":{"_id":"file-one"}}']),
  );
  jest.doMock('../../src/core/rcapi', () => ({ rcapi: { call, multipart } }));
  return { mod: require('../../src/seed/client') as typeof ClientNS, call, multipart };
}

describe('seed REST decoding and pagination', () => {
  afterEach(() => jest.resetModules());

  it('reads every page and propagates the acting participant credentials', async () => {
    const { mod, call } = load((_path, options) => {
      const params = options.params as { offset: number };
      const count = Math.min(100, 205 - params.offset);
      return [
        200,
        JSON.stringify({
          success: true,
          users: Array.from({ length: count }, (_, i) => ({ _id: `user-${params.offset + i}` })),
          total: 205,
        }),
      ];
    });
    const client = new mod.Client('http://x');
    const headers = { 'X-Auth-Token': 'alice-token', 'X-User-Id': 'alice-id' };
    const users = await client.pages('/api/v1/channels.members', headers, 'users', {
      roomId: 'private-room',
    });
    expect(users).toHaveLength(205);
    expect(new Set(users.map((u) => u._id)).size).toBe(205);
    expect(call.mock.calls.map(([, , , options]) => options.params)).toEqual([
      { roomId: 'private-room', count: 100, offset: 0 },
      { roomId: 'private-room', count: 100, offset: 100 },
      { roomId: 'private-room', count: 100, offset: 200 },
    ]);
    for (const [, , , options] of call.mock.calls) expect(options.extraHeaders).toEqual(headers);
  });

  it('rejects a success-false body even when the HTTP status is successful', async () => {
    const { mod } = load(() => [200, '{"success":false,"errorType":"error-not-allowed"}']);
    const client = new mod.Client('http://x');
    await expect(
      client.post('/api/v1/chat.react', {}, { messageId: 'one', shouldReact: true }),
    ).rejects.toThrow(/error-not-allowed/u);
  });

  it('rejects invalid JSON and empty or scalar responses instead of inferring success', async () => {
    for (const text of ['<html>proxy error</html>', '{}', '[]', 'false', '12', 'null']) {
      const { mod } = load(() => [200, text]);
      await expect(new mod.Client('http://x').get('/api/v1/rooms.info', {})).rejects.toThrow(
        /response|JSON/u,
      );
    }
  });

  it('refuses an absent listing or a page that stops before its declared total', async () => {
    for (const body of [{ success: true }, { success: true, users: [], total: 10 }]) {
      const { mod } = load(() => [200, JSON.stringify(body)]);
      await expect(
        new mod.Client('http://x').pages('/api/v1/users.list', {}, 'users'),
      ).rejects.toThrow(/missing|before/u);
    }
  });

  it('uses the same response checks for multipart uploads', async () => {
    const { mod, multipart } = load(() => [200, '{"success":true}']);
    const client = new mod.Client('http://x');
    const parts = [
      { name: 'file', value: Buffer.from('sample'), filename: 'sample.txt', type: 'text/plain' },
    ];
    expect(
      await client.multipart('/api/v1/rooms.media/room-one', { 'X-User-Id': 'alice' }, parts),
    ).toEqual({ success: true, file: { _id: 'file-one' } });
    expect(multipart).toHaveBeenCalledWith(
      'http://x',
      '/api/v1/rooms.media/room-one',
      { 'X-User-Id': 'alice' },
      parts,
    );
    multipart.mockResolvedValueOnce([403, '{"success":false,"errorType":"error-not-allowed"}']);
    await expect(client.multipart('/api/v1/rooms.media/room-one', {}, parts)).rejects.toThrow(
      /403/u,
    );
  });

  it('proves a blank probe lookup present or absent through every authorized room page', async () => {
    const headers = { 'X-Auth-Token': 'carol-token', 'X-User-Id': 'carol-id' };
    for (const status of [400, 404]) {
      for (const present of [false, true]) {
        const all = Array.from({ length: 205 }, (_, i) => ({
          _id: present && i === 204 ? 'permission-probe' : `older-message-${i}`,
          rid: 'private-room',
          u: { _id: 'carol-id' },
        }));
        const { mod, call } = load((path, options) => {
          if (path === '/api/v1/chat.getMessage') return [status, '{"success":false}'];
          const params = options.params as { offset: number; count: number };
          return [
            200,
            JSON.stringify({
              success: true,
              messages: all.slice(params.offset, params.offset + params.count),
              total: all.length,
            }),
          ];
        });
        const found = await new mod.Client('http://x').pendingMessage(
          'permission-probe',
          'private-room',
          'groups',
          headers,
        );
        expect(found).toEqual(present ? all[204] : null);
        const pages = call.mock.calls.filter(([, , path]) => path === '/api/v1/groups.messages');
        expect(pages.map(([, , , options]) => options.params)).toEqual([
          { roomId: 'private-room', count: 100, offset: 0 },
          { roomId: 'private-room', count: 100, offset: 100 },
          { roomId: 'private-room', count: 100, offset: 200 },
        ]);
        for (const [, , , options] of call.mock.calls)
          expect(options.extraHeaders).toEqual(headers);
      }
    }
  });

  it('refuses to infer a probe is absent after unreadable or incomplete room history', async () => {
    for (const listing of [
      [500, '{"success":false}'],
      [200, '{"success":true,"messages":[],"total":205}'],
    ] as [number, string][]) {
      const { mod } = load((path) =>
        path === '/api/v1/chat.getMessage' ? [400, '{"success":false}'] : listing,
      );
      await expect(
        new mod.Client('http://x').pendingMessage('permission-probe', 'room-one', 'channels', {}),
      ).rejects.toThrow(/refused|before its total/u);
    }
    const { mod, call } = load(() => [400, '{"success":false,"errorType":"error-not-allowed"}']);
    await expect(
      new mod.Client('http://x').pendingMessage('permission-probe', 'room-one', 'channels', {}),
    ).rejects.toThrow(/error-not-allowed/u);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["You can't send messages because the room is readonly.", 'error-room-read-only'],
    ['You_have_been_muted', 'error-user-muted'],
  ])('normalizes the observed legacy permission error %s', async (error, errorType) => {
    const { mod } = load(() => [400, JSON.stringify({ success: false, error })]);
    await expect(
      new mod.Client('http://x').post('/api/v1/chat.sendMessage', {}, { message: {} }),
    ).rejects.toMatchObject({ status: 400, errorType });
  });
});

describe('seed requests refused by the Rocket.Chat rate limiter', () => {
  afterEach(() => jest.resetModules());

  const refusal = (seconds = 49): string =>
    JSON.stringify({
      success: false,
      error: `Error, too many requests. Please slow down. You must wait ${seconds} seconds before trying this endpoint again. [error-too-many-requests]`,
    });

  it('completes a refused message after the epoch-ms reset using its original id and actor', async () => {
    let attempts = 0;
    const { mod, call } = load((_path, options) => {
      attempts += 1;
      return attempts === 1
        ? [
            429,
            refusal(),
            { date: 'Sat, 10 Oct 2026 09:48:24 GMT', 'x-ratelimit-reset': '1791625753228' },
          ]
        : [200, JSON.stringify({ success: true, message: (options.data as Bag).message })];
    });
    const sleep = jest.fn(() => Promise.resolve());
    const log = jest.fn();
    const client = new mod.Client('http://x', { sleep, log });
    const headers = { 'X-Auth-Token': 'alice-token', 'X-User-Id': 'alice-id' };
    const payload = { message: { _id: 'hs-owned-message', rid: 'room', msg: 'sample' } };
    await expect(client.post('/api/v1/chat.sendMessage', headers, payload)).resolves.toEqual({
      success: true,
      message: payload.message,
    });
    expect(sleep).toHaveBeenCalledWith(49_478);
    expect(call).toHaveBeenCalledTimes(2);
    for (const [, , , options] of call.mock.calls) {
      expect(options.extraHeaders).toBe(headers);
      expect(options.data).toBe(payload);
    }
    expect(log).toHaveBeenCalledWith(expect.stringContaining('rate-limited'));
    expect(JSON.stringify(log.mock.calls)).not.toContain('alice-token');
  });

  it('honors the longer Retry-After when a reaction is definitively refused', async () => {
    let attempts = 0;
    const { mod, call } = load(() => {
      attempts += 1;
      return attempts === 1
        ? [429, refusal(1), { 'retry-after': '3', 'x-ratelimit-reset': '2000' }]
        : [200, '{"success":true}'];
    });
    const sleep = jest.fn(() => Promise.resolve());
    await expect(
      new mod.Client('http://x', { sleep, now: () => 1000 }).post(
        '/api/v1/chat.react',
        { 'X-User-Id': 'bob' },
        { messageId: 'owned-message', emoji: 'smile', shouldReact: true },
      ),
    ).resolves.toEqual({ success: true });
    expect(sleep).toHaveBeenCalledWith(3250);
    expect(call.mock.calls.map(([, , , options]) => options.data)).toEqual([
      { messageId: 'owned-message', emoji: 'smile', shouldReact: true },
      { messageId: 'owned-message', emoji: 'smile', shouldReact: true },
    ]);
  });

  it('reads a rate-limited star as its original owner after the full server delay', async () => {
    let attempts = 0;
    const message = { _id: 'starred-message', starred: [{ _id: 'uid-alice' }] };
    const { mod, call } = load(() => {
      attempts += 1;
      return attempts === 1
        ? [429, refusal(1), { 'retry-after': '3', 'x-ratelimit-reset': '6000' }]
        : [200, JSON.stringify({ success: true, message })];
    });
    const sleep = jest.fn(() => Promise.resolve());
    const log = jest.fn();
    const headers = { 'X-Auth-Token': 'alice-token', 'X-User-Id': 'uid-alice' };
    const params = { msgId: message._id };
    await expect(
      new mod.Client('http://x', { sleep, log, now: () => 1000 }).get(
        '/api/v1/chat.getMessage',
        headers,
        params,
      ),
    ).resolves.toEqual({ success: true, message });
    expect(sleep.mock.calls).toEqual([[5250]]);
    expect(call).toHaveBeenCalledTimes(2);
    for (const [, method, path, options] of call.mock.calls) {
      expect(method).toBe('GET');
      expect(path).toBe('/api/v1/chat.getMessage');
      expect(options.extraHeaders).toBe(headers);
      expect(options.params).toBe(params);
      expect(options).not.toHaveProperty('data');
    }
    expect(log).toHaveBeenCalledWith(expect.stringContaining('refused request'));
    expect(JSON.stringify(log.mock.calls)).not.toContain('alice-token');
  });

  it('honors an HTTP-date Retry-After using the response clock', async () => {
    let attempts = 0;
    const { mod } = load(() => {
      attempts += 1;
      return attempts === 1
        ? [
            429,
            '{"success":false,"errorType":"error-too-many-requests"}',
            {
              date: 'Sat, 10 Oct 2026 09:48:24 GMT',
              'retry-after': 'Sat, 10 Oct 2026 09:48:29 GMT',
            },
          ]
        : [200, '{"success":true}'];
    });
    const sleep = jest.fn(() => Promise.resolve());
    await expect(
      new mod.Client('http://x', { sleep, now: () => 0 }).post('/api/v1/chat.react', {}, {}),
    ).resolves.toEqual({ success: true });
    expect(sleep).toHaveBeenCalledWith(5250);
  });

  it('keeps exhausted rate-limit refusals as failures within two retries', async () => {
    for (const method of ['POST', 'GET']) {
      const { mod, call } = load(() => [429, refusal(1)]);
      const sleep = jest.fn(() => Promise.resolve());
      const client = new mod.Client('http://x', { sleep });
      await expect(
        method === 'POST'
          ? client.post('/api/v1/chat.sendMessage', {}, { message: { _id: 'owned-message' } })
          : client.get('/api/v1/chat.getMessage', {}, { msgId: 'owned-message' }),
      ).rejects.toMatchObject({ status: 429, errorType: 'error-too-many-requests' });
      expect(call).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls).toEqual([[1250], [1250]]);
    }
  });

  it('shares one bounded wait allowance across messages, reactions and star readback', async () => {
    let attempts = 0;
    const { mod, call } = load(() => {
      attempts += 1;
      return attempts % 2 === 1 ? [429, refusal(59)] : [200, '{"success":true}'];
    });
    const sleep = jest.fn(() => Promise.resolve());
    const client = new mod.Client('http://x', { sleep });
    await expect(client.post('/api/v1/chat.sendMessage', {}, {})).resolves.toEqual({
      success: true,
    });
    await expect(client.post('/api/v1/chat.react', {}, {})).resolves.toEqual({ success: true });
    await expect(
      client.get('/api/v1/chat.getMessage', {}, { msgId: 'owned-message' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(call).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls).toEqual([[59_250], [59_250]]);
  });

  it('refuses waits beyond the allowance instead of retrying before the server permits', async () => {
    for (const [method, path] of [
      ['POST', '/api/v1/chat.react'],
      ['GET', '/api/v1/chat.getMessage'],
    ] as const) {
      const { mod, call } = load(() => [429, refusal(1), { 'retry-after': '121' }]);
      const sleep = jest.fn(() => Promise.resolve());
      await expect(
        new mod.Client('http://x', { sleep }).request(method, path, {}),
      ).rejects.toMatchObject({ status: 429 });
      expect(call).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it('never repeats unrecognized, malformed, uncertain or unrelated refusals', async () => {
    const replies: [number, string][] = [
      [429, '{"success":false,"error":"Too many requests"}'],
      [429, '{"success":true,"errorType":"error-too-many-requests"}'],
      [429, '{"success":false,"errorType":"error-too-many-requests"}'],
      [429, '<html>proxy refusal</html>'],
      [500, refusal(1)],
      [403, refusal(1)],
    ];
    for (const [method, path] of [
      ['POST', '/api/v1/chat.sendMessage'],
      ['GET', '/api/v1/chat.getMessage'],
    ] as const) {
      for (const reply of replies) {
        const { mod, call } = load(() => reply);
        const sleep = jest.fn(() => Promise.resolve());
        await expect(
          new mod.Client('http://x', { sleep }).request(method, path, {}),
        ).rejects.toThrow();
        expect(call).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
      }
    }
    const { mod, call } = load(() => [429, refusal(1)]);
    const sleep = jest.fn(() => Promise.resolve());
    await expect(
      new mod.Client('http://x', { sleep }).post('/api/v1/users.create', {}, {}),
    ).rejects.toMatchObject({ status: 429 });
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    await expect(
      new mod.Client('http://x', { sleep }).get('/api/v1/rooms.info', {}, { roomId: 'room' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(call).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('never retries transport errors or multipart uploads', async () => {
    const { mod, call, multipart } = load(() => [200, '{"success":true}']);
    call.mockRejectedValueOnce(new Error('socket closed after the mutation was sent'));
    const sleep = jest.fn(() => Promise.resolve());
    const client = new mod.Client('http://x', { sleep });
    await expect(
      client.post('/api/v1/chat.sendMessage', {}, { message: { _id: 'owned-message' } }),
    ).rejects.toThrow(/socket closed/u);
    expect(call).toHaveBeenCalledTimes(1);
    call.mockRejectedValueOnce(new Error('socket closed before readback completed'));
    await expect(
      client.get('/api/v1/chat.getMessage', {}, { msgId: 'owned-message' }),
    ).rejects.toThrow(/socket closed/u);
    expect(call).toHaveBeenCalledTimes(2);
    multipart.mockResolvedValueOnce([429, refusal(1)]);
    await expect(client.multipart('/api/v1/rooms.media/room', {}, [])).rejects.toMatchObject({
      status: 429,
    });
    expect(multipart).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops before another request attempt when its wait is interrupted', async () => {
    for (const [method, path] of [
      ['POST', '/api/v1/chat.react'],
      ['GET', '/api/v1/chat.getMessage'],
    ] as const) {
      const { mod, call } = load(() => [429, refusal(1)]);
      const sleep = jest.fn(() => Promise.reject(new Error('stopped by the owner')));
      await expect(new mod.Client('http://x', { sleep }).request(method, path, {})).rejects.toThrow(
        /stopped by the owner/u,
      );
      expect(call).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledTimes(1);
    }
  });
});
