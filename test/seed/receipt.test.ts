import * as fs from 'node:fs';
import * as path from 'node:path';

import { workspace } from '../../src/core/runner/paths';
import { planFrom } from '../../src/seed/plan';
import { Receipt } from '../../src/seed/receipt';

let currentName = '';
let ordinal = 0;

function journal(receipt: Receipt): string {
  return path.join(workspace(currentName), 'seed-receipts', `${receipt.manifest.run}.wal`);
}

describe('durable seed execution receipts', () => {
  beforeEach(() => {
    currentName = `receipt-test-${ordinal}`;
    ordinal += 1;
  });
  it('writes an intent before mutation and resumes the same historical batch and reference time', async () => {
    const plan = planFrom('small', { historyDays: 180 });
    const first = new Receipt(plan, 'database-identity', currentName);
    const mid = first.identifier('message:general:main-0');
    const serverWrite = jest.fn(async () => {
      expect(fs.readFileSync(journal(first), 'utf8')).toContain('"state":"intent"');
      throw new Error('connection lost after the server accepted the message');
    });
    await expect(first.step('message:general:main-0', { mid }, serverWrite)).rejects.toThrow(
      'connection lost',
    );

    const resumed = new Receipt(plan, 'database-identity', currentName);
    expect(resumed.manifest.run).toBe(first.manifest.run);
    expect(resumed.manifest.reference).toBe(first.manifest.reference);
    expect(resumed.identifier('message:general:main-0')).toBe(mid);
    const repeatWrite = jest.fn(async () => ({ mid: 'duplicate' }));
    const recovered = await resumed.step(
      'message:general:main-0',
      { mid },
      repeatWrite,
      async (intent) => {
        expect(intent.mid).toBe(mid);
        return { mid };
      },
    );
    expect(recovered.mid).toBe(mid);
    expect(repeatWrite).not.toHaveBeenCalled();
    expect(resumed.intent('message:general:main-0')).toBeNull();
    expect(resumed.done('message:general:main-0')).toEqual({ mid });
  });

  it('refuses an uncertain write when it cannot reconcile the existing intent', async () => {
    const receipt = new Receipt(planFrom('small'));
    receipt.record('upload:one', 'intent', { rid: 'room-one' });
    const repeat = jest.fn(async () => ({ fid: 'duplicate' }));
    await expect(receipt.step('upload:one', { rid: 'room-one' }, repeat)).rejects.toThrow(
      /uncertain/u,
    );
    expect(repeat).not.toHaveBeenCalled();
  });

  it('returns completed operations without repeating their server mutation', async () => {
    const receipt = new Receipt(planFrom('small'));
    receipt.record('pin:one', 'done', { mid: 'message-one' });
    const repeat = jest.fn(async () => ({ mid: 'message-two' }));
    expect(await receipt.step('pin:one', {}, repeat)).toEqual({ mid: 'message-one' });
    expect(repeat).not.toHaveBeenCalled();
  });

  it('rejects different options or a changed database while a batch is unfinished', () => {
    const plan = planFrom('small', { historyDays: 180 });
    const first = new Receipt(plan, 'original-database', currentName);
    first.record('history:adjust', 'intent', { messages: ['message-one'] });
    const bytes = fs.readFileSync(journal(first));
    expect(
      () => new Receipt(planFrom('small', { historyDays: 30 }), 'original-database', currentName),
    ).toThrow(/unfinished/u);
    expect(() => new Receipt(plan, 'different-database', currentName)).toThrow(/unfinished/u);
    expect(fs.readFileSync(journal(first))).toEqual(bytes);
  });

  it('starts a new append batch after completion while retaining seed-owned identities', () => {
    const first = new Receipt(planFrom('small'), 'database-identity', currentName);
    first.record('room:platform', 'done', { rid: 'team-main', teamId: 'team-id' });
    first.record('user:alice', 'done', { uid: 'alice-id' });
    first.finish();
    const next = new Receipt(planFrom('standard'), 'database-identity', currentName);
    expect(next.manifest.run).not.toBe(first.manifest.run);
    expect(next.owned.get('room:platform')).toEqual({ rid: 'team-main', teamId: 'team-id' });
    expect(next.owned.get('user:alice')).toEqual({ uid: 'alice-id' });
    expect(next.done('room:platform')).toBeNull();
    expect(next.identifier('message:general:main-0')).not.toBe(
      first.identifier('message:general:main-0'),
    );
  });

  it('rejects credentials recursively before writing them to disk', () => {
    const receipt = new Receipt(planFrom('small'), 'database-identity', currentName);
    const bytes = fs.readFileSync(journal(receipt));
    for (const key of ['token', 'password', 'authorization', 'mongoUrl']) {
      expect(() =>
        receipt.record('unsafe', 'done', { nested: [{ [key]: 'never-persist-this' }] }),
      ).toThrow(/credentials/u);
    }
    expect(fs.readFileSync(journal(receipt))).toEqual(bytes);
  });

  it('rejects a corrupt completed record rather than repeating uncertain mutations', () => {
    const plan = planFrom('small');
    const receipt = new Receipt(plan, 'database-identity', currentName);
    receipt.record('room:one', 'done', { rid: 'original-room' });
    fs.writeFileSync(
      journal(receipt),
      fs.readFileSync(journal(receipt), 'utf8').replace('original-room', 'another-room'),
    );
    expect(() => new Receipt(plan, 'database-identity', currentName)).toThrow(/corrupt/u);
  });

  it('discards a torn final record while preserving the earlier durable intent', () => {
    const plan = planFrom('small');
    const receipt = new Receipt(plan, 'database-identity', currentName);
    receipt.record('upload:one', 'intent', { rid: 'original-room' });
    const bytes = fs.readFileSync(journal(receipt));
    fs.appendFileSync(journal(receipt), '{"key":"upload:one","state":"done"');
    const resumed = new Receipt(plan, 'database-identity', currentName);
    expect(resumed.intent('upload:one')).toEqual({ rid: 'original-room' });
    expect(resumed.done('upload:one')).toBeNull();
    expect(fs.readFileSync(journal(resumed))).toEqual(bytes);
  });
});
