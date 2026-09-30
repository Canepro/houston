import * as fs from 'node:fs';
import * as path from 'node:path';

import type * as ErrorsNS from '../../../src/lib/errors';

jest.mock('../../../src/core/data', () => {
  const nativeFs = require('node:fs') as typeof fs;
  return {
    importPlan: jest.fn(async () => ({ counts: { apply: 1, redacted: 0, denied: 0 } })),
    importApply: jest.fn(
      async (_name: string, settingsPath: string, selected: ReadonlySet<string> | null) => ({
        contents: nativeFs.readFileSync(settingsPath, 'utf8'),
        only: [...(selected ?? [])],
      }),
    ),
    runScale: jest.fn(),
    clearScale: jest.fn(),
  };
});
jest.mock('../../../src/core/lifecycle/naming', () => {
  const { NotFoundError } = require('../../../src/lib/errors') as typeof ErrorsNS;
  return {
    resolveName: async (name: string) => {
      if (name === 'missing-order') throw new NotFoundError('no such repro');
      return name;
    },
  };
});

import { workspace } from '../../../src/core/runner/paths';
import * as dataService from '../../../src/core/data';
import { createApp } from '../../../src/web/app';
import { MAX_UPLOAD_BYTES } from '../../../src/web/routes/data';

const mockImportApply = jest.mocked(dataService.importApply);

function multipart(contents: Buffer, only = ''): { payload: Buffer; contentType: string } {
  const boundary = 'houston-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="only"\r\n\r\n${only}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="settings.json"\r\n` +
      'Content-Type: application/json\r\n\r\n',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, contents, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function multipartWithoutFile(): { payload: Buffer; contentType: string } {
  const boundary = 'houston-boundary-missing';
  return {
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="only"\r\n\r\nAccounts_One\r\n` +
        `--${boundary}--\r\n`,
    ),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('settings upload pinning', () => {
  it('returns the established 422 when the required file part is absent', async () => {
    const app = await createApp({ accounts: false });
    try {
      const body = multipartWithoutFile();
      const response = await app.inject({
        method: 'POST',
        url: '/api/repros/missing/config-import/plan',
        headers: { 'content-type': body.contentType },
        payload: body.payload,
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().detail[0]).toEqual(
        expect.objectContaining({ type: 'missing', loc: ['body', 'file'] }),
      );
    } finally {
      await app.close();
    }
  });

  it('returns the same missing-file 422 for a non-multipart request', async () => {
    const app = await createApp({ accounts: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/repros/missing/config-import/plan',
        headers: { 'content-type': 'text/plain' },
        payload: 'not multipart',
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().detail[0]).toEqual(
        expect.objectContaining({ type: 'missing', loc: ['body', 'file'] }),
      );
    } finally {
      await app.close();
    }
  });

  it('uses the final repeated file part, as earlier releases selected a scalar form field', async () => {
    const boundary = 'houston-repeated-file';
    const part = (name: string, contents: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: application/json\r\n\r\n${contents}\r\n`;
    const payload = Buffer.from(
      part('first.json', '{"which":"first"}') +
        part('second.json', '{"which":"second"}') +
        `--${boundary}--\r\n`,
    );
    const app = await createApp({ accounts: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/repros/demo/config-import/plan',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      expect(response.statusCode).toBe(200);
      const uploadId = response.json().upload_id as string;
      expect(
        fs.readFileSync(path.join(workspace('demo'), 'import', `${uploadId}.json`), 'utf8'),
      ).toBe('{"which":"second"}');
      fs.rmSync(path.join(workspace('demo'), 'import', `${uploadId}.json`), { force: true });
      fs.rmSync(path.join(workspace('demo'), 'import', `${uploadId}.only`), { force: true });
    } finally {
      await app.close();
    }
  });

  it.each([
    ['one byte below', MAX_UPLOAD_BYTES - 1, 200],
    ['at the cap', MAX_UPLOAD_BYTES, 200],
    ['one byte above', MAX_UPLOAD_BYTES + 1, 400],
  ])('enforces the 16 MiB cap while consuming: %s', async (_label, size, status) => {
    const app = await createApp({ accounts: false });
    try {
      const body = multipart(Buffer.alloc(size as number, 0x20));
      const response = await app.inject({
        method: 'POST',
        url: '/api/repros/demo/config-import/plan',
        headers: { 'content-type': body.contentType },
        payload: body.payload,
      });
      expect(response.statusCode).toBe(status);
      if (status === 400) expect(response.json().error).toBe('settings file is larger than 16 MB');
    } finally {
      await app.close();
    }
  });

  it('resolves the target before reporting the handler-level upload cap', async () => {
    const app = await createApp({ accounts: false });
    try {
      const body = multipart(Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x20));
      const response = await app.inject({
        method: 'POST',
        url: '/api/repros/missing-order/config-import/plan',
        headers: { 'content-type': body.contentType },
        payload: body.payload,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe('no such repro');
    } finally {
      await app.close();
    }
  });

  it('rejects an oversized stream even when Content-Length claims one byte', async () => {
    const app = await createApp({ accounts: false });
    try {
      const body = multipart(Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x20));
      const response = await app.inject({
        method: 'POST',
        url: '/api/repros/demo/config-import/plan',
        headers: { 'content-type': body.contentType, 'content-length': '1' },
        payload: body.payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('settings file is larger than 16 MB');
    } finally {
      await app.close();
    }
  });

  it('rejects malformed, traversal-shaped, and missing upload ids', async () => {
    const app = await createApp({ accounts: false });
    try {
      for (const uploadId of ['', '../passwd', 'u123', 'u00000000000g']) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/repros/demo/config-import',
          payload: { upload_id: uploadId },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error).toContain('malformed upload_id');
      }
      const missing = await app.inject({
        method: 'POST',
        url: '/api/repros/demo/config-import',
        payload: { upload_id: 'u0123456789ab' },
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error).toContain('no uploaded settings.json');
    } finally {
      await app.close();
    }
  });

  it('runs a scale and its undo as jobs', async () => {
    const app = await createApp({ accounts: false });
    try {
      const scale = await app.inject({
        method: 'POST',
        url: '/api/repros/scaled/scale',
        payload: { scale: 'users=5' },
      });
      expect(scale.statusCode).toBe(200);
      expect(String(scale.json().job_id)).toMatch(/^job_/u);
      const clear = await app.inject({ method: 'DELETE', url: '/api/repros/scaled/scale' });
      expect(clear.statusCode).toBe(200);
      expect(String(clear.json().job_id)).toMatch(/^job_/u);
      expect(await app.jobs.drain()).toEqual([]);
      expect(dataService.runScale).toHaveBeenCalledWith('scaled', 'users=5', expect.any(Function));
      expect(dataService.clearScale).toHaveBeenCalledWith('scaled', expect.any(Function));
    } finally {
      await app.close();
    }
  });

  it('answers the plan and files each upload under its own id', async () => {
    // One file per upload rather than a shared settings.json: two tabs previewing
    // different dumps used to race, and the second silently won the first's apply.
    const app = await createApp({ accounts: false });
    try {
      const body = multipart(Buffer.from('[]'));
      const response = await app.inject({
        method: 'POST',
        url: '/api/repros/planned/config-import/plan',
        headers: { 'content-type': body.contentType },
        payload: body.payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().counts.apply).toBe(1);
      const uploadId = response.json().upload_id as string;
      expect(fs.existsSync(path.join(workspace('planned'), 'import', `${uploadId}.json`))).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });

  it('never lets two uploads collide on one file', async () => {
    const app = await createApp({ accounts: false });
    const mockImportPlan = jest.mocked(dataService.importPlan);
    mockImportPlan.mockClear();
    try {
      const ids: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const body = multipart(Buffer.from('[]'));
        const response = await app.inject({
          method: 'POST',
          url: '/api/repros/twotabs/config-import/plan',
          headers: { 'content-type': body.contentType },
          payload: body.payload,
        });
        ids.push(response.json().upload_id as string);
      }
      expect(ids[0]).not.toBe(ids[1]);
      expect(new Set(mockImportPlan.mock.calls.map((call) => call[1])).size).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('refuses an apply that no preview came before', async () => {
    const app = await createApp({ accounts: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/repros/unpreviewed/config-import',
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('applies the filter that was previewed, not the one the apply asks for', async () => {
    // The whole point of the preview step is that what was reviewed is what runs.
    const app = await createApp({ accounts: false });
    mockImportApply.mockClear();
    try {
      const body = multipart(Buffer.from('[]'), 'Livechat,LDAP');
      const plan = await app.inject({
        method: 'POST',
        url: '/api/repros/filtered/config-import/plan',
        headers: { 'content-type': body.contentType },
        payload: body.payload,
      });
      const uploadId = plan.json().upload_id as string;
      const apply = await app.inject({
        method: 'POST',
        url: '/api/repros/filtered/config-import',
        payload: { upload_id: uploadId, only: 'Accounts' },
      });
      expect(apply.statusCode).toBe(200);
      expect(await app.jobs.drain()).toEqual([]);
      expect(mockImportApply.mock.calls[0]?.[2]).toEqual(new Set(['Livechat', 'LDAP']));
    } finally {
      await app.close();
    }
  });

  it('keeps only the newest five previewed-but-never-applied dumps', async () => {
    // Nothing else deletes a preview that was never applied, and these are customers'
    // config files -- they must not accumulate without bound.
    const app = await createApp({ accounts: false });
    try {
      for (let index = 0; index < 8; index += 1) {
        const body = multipart(Buffer.from('[]'));
        await app.inject({
          method: 'POST',
          url: '/api/repros/pruned/config-import/plan',
          headers: { 'content-type': body.contentType },
          payload: body.payload,
        });
      }
      const kept = fs
        .readdirSync(path.join(workspace('pruned'), 'import'))
        .filter((entry) => /^u.*\.json$/u.test(entry));
      expect(kept).toHaveLength(5);
    } finally {
      await app.close();
    }
  });

  it('rereads the server-pinned dump and .only filter, ignoring replacement fields', async () => {
    const directory = path.join(workspace('demo'), 'import');
    fs.mkdirSync(directory, { recursive: true });
    const uploadId = 'u0123456789ab';
    fs.writeFileSync(path.join(directory, `${uploadId}.json`), '{"server":"pinned"}', 'utf8');
    fs.writeFileSync(
      path.join(directory, `${uploadId}.only`),
      'Accounts_One, Accounts_Two',
      'utf8',
    );
    const replacementPath = path.join(directory, 'request-replacement.json');
    fs.writeFileSync(replacementPath, '{"request":"replacement"}', 'utf8');
    const app = await createApp({ accounts: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/repros/demo/config-import',
        payload: {
          upload_id: uploadId,
          path: replacementPath,
          content: '{"request":"replacement"}',
          only: 'Attacker_Replacement',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(await app.jobs.drain()).toEqual([]);
      const job = app.jobs.get(response.json().job_id as string);
      expect(job?.result).toEqual({
        contents: '{"server":"pinned"}',
        only: ['Accounts_One', 'Accounts_Two'],
      });
      expect(mockImportApply).toHaveBeenCalledWith(
        'demo',
        path.join(directory, `${uploadId}.json`),
        new Set(['Accounts_One', 'Accounts_Two']),
        expect.any(Function),
      );
      expect(fs.existsSync(path.join(directory, `${uploadId}.json`))).toBe(false);
      expect(fs.existsSync(path.join(directory, `${uploadId}.only`))).toBe(false);
    } finally {
      await app.close();
      fs.rmSync(replacementPath, { force: true });
    }
  });
});
