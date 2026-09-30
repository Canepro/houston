import { createApp } from '../../../src/web/app';

describe('the frozen SPA fallback', () => {
  it('serves frozen assets with their wire content types', async () => {
    const app = await createApp({ accounts: false });
    try {
      const page = await app.inject({ method: 'GET', url: '/' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(page.body).toContain('<!doctype html>');
      expect(page.headers.etag).toMatch(/^"[0-9a-f]{32}"$/u);
      expect(page.headers['last-modified']).toBeDefined();
      expect(page.headers['content-length']).toBe(String(Buffer.byteLength(page.body)));

      const script = await app.inject({ method: 'GET', url: '/js/main.js' });
      expect(script.statusCode).toBe(200);
      expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(script.headers['accept-ranges']).toBe('bytes');

      const partial = await app.inject({
        method: 'GET',
        url: '/js/main.js',
        headers: { range: 'bytes=0-8' },
      });
      expect(partial.statusCode).toBe(206);
      expect(partial.headers['content-range']).toBe(
        `bytes 0-8/${String(Buffer.byteLength(script.body))}`,
      );
      expect(partial.headers['content-length']).toBe('9');
      expect(partial.body).toBe(script.body.slice(0, 9));

      const ifRangeMiss = await app.inject({
        method: 'GET',
        url: '/js/main.js',
        headers: { range: 'bytes=0-8', 'if-range': '"not-the-current-etag"' },
      });
      expect(ifRangeMiss.statusCode).toBe(200);
      expect(ifRangeMiss.body).toBe(script.body);

      const weakNotModified = await app.inject({
        method: 'GET',
        url: '/js/main.js',
        headers: { 'if-none-match': `"other", W/${String(script.headers.etag)}` },
      });
      expect(weakNotModified.statusCode).toBe(304);

      for (const [range, status, body] of [
        ['items=0-1', 400, 'Only support bytes range'],
        ['bytes=bogus', 400, 'Range header: range must be requested'],
        ['bytes=3-1', 400, 'Range header: start must be less than end'],
        ['bytes=999999999-', 416, ''],
      ] as const) {
        const invalid = await app.inject({
          method: 'GET',
          url: '/js/main.js',
          headers: { range },
        });
        expect(invalid.statusCode).toBe(status);
        expect(invalid.body).toBe(body);
        expect(invalid.headers.etag).toBeUndefined();
        expect(invalid.headers['last-modified']).toBeUndefined();
        expect(invalid.headers['accept-ranges']).toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });

  it('never turns an unknown protected API path into successful HTML', async () => {
    const app = await createApp({ accounts: false });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/not-a-route' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json()).toEqual({ detail: 'Not Found' });

      const head = await app.inject({ method: 'HEAD', url: '/api/not-a-route' });
      expect(head.statusCode).toBe(404);
      expect(head.headers['content-type']).toContain('application/json');

      const page = await app.inject({ method: 'GET', url: '/not-a-real-spa-route' });
      expect(page.statusCode).toBe(404);
      expect(page.headers['content-type']).toContain('application/json');
      expect(page.json()).toEqual({ detail: 'Not Found' });
    } finally {
      await app.close();
    }
  });
});
