import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { download, multipart } from '../../src/core/rcapi';

const servers: http.Server[] = [];
async function serve(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('seed media through the real HTTP seam', () => {
  it('sends binary multipart bytes with the actor headers and an actual boundary', async () => {
    const payload = Buffer.from([0, 255, 13, 10, 1, 128]);
    let body = Buffer.alloc(0);
    let headers: http.IncomingHttpHeaders = {};
    const root = await serve((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        body = Buffer.concat(chunks);
        headers = request.headers;
        response.end('{"success":true}');
      });
    });
    expect(
      await multipart(
        root,
        '/api/v1/rooms.media/room',
        { 'X-Auth-Token': 'actor-token', 'Content-Type': 'application/json' },
        [{ name: 'file', filename: 'seed.png', type: 'image/png', value: payload }],
      ),
    ).toEqual([200, '{"success":true}']);
    expect(headers['x-auth-token']).toBe('actor-token');
    const boundary = /boundary=(.+)$/u.exec(String(headers['content-type']))?.[1];
    expect(boundary).toBeDefined();
    expect(body.includes(payload)).toBe(true);
    expect(body.toString('latin1')).toContain('name="file"; filename="seed.png"');
    expect(body.toString('latin1')).toContain(`--${boundary}--\r\n`);
  });
  it('preserves the exact decompressed download bytes', async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 128]);
    const root = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Encoding': 'gzip' });
      response.end(gzipSync(bytes));
    });
    const result = await download(root, '/file-upload/sample', {});
    expect(result.bytes).toEqual(bytes);
    expect(result.ok).toBe(true);
  });
  it('refuses external redirects before disclosing a participant token', async () => {
    let reached = 0;
    const external = await serve((_request, response) => {
      reached += 1;
      response.end('unwanted');
    });
    const root = await serve((_request, response) => {
      response.writeHead(302, { Location: external + '/file' });
      response.end();
    });
    await expect(
      download(root, '/file?rc_token=private-session', { 'X-Auth-Token': 'private-session' }),
    ).rejects.toThrow('workspace file download could not be completed');
    expect(reached).toBe(0);
    await expect(download(root, external + '/file', {})).rejects.toThrow('workspace origin');
    expect(reached).toBe(0);
  });
  it('keeps failed authenticated download URLs out of persisted error text', async () => {
    const root = await serve((request) => request.socket.destroy());
    let caught: unknown;
    try {
      await download(root, '/file?rc_uid=alice&rc_token=private-session', {
        'X-Auth-Token': 'private-session',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'CREATE_FAILED', exitCode: 7 });
    expect(String(caught)).not.toContain('private-session');
    expect(String(caught)).not.toContain('rc_token');
  });
});
