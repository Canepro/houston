import { asset, avatar, profile } from '../../src/seed/assets';
import { username } from '../../src/seed/wording';

describe('packaged seed media and user profiles', () => {
  it('ships an image, a PDF, a readable Unicode runbook and a parseable CSV', () => {
    const image = asset('png');
    expect(image.type).toBe('image/png');
    expect(image.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const document = asset('pdf');
    expect(document.type).toBe('application/pdf');
    expect(document.bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    const runbook = asset('txt');
    expect(runbook.type).toBe('text/plain');
    const text = runbook.bytes.toString('utf8');
    for (const example of ['INC-4821', 'नमस्ते', 'مرحبا', '你好']) expect(text).toContain(example);
    const spreadsheet = asset('csv');
    expect(spreadsheet.type).toBe('text/csv');
    const rows = spreadsheet.bytes
      .toString('utf8')
      .trim()
      .split('\n')
      .map((row) => row.split(','));
    expect(rows[0]).toEqual(['stage', 'count']);
    expect(rows.slice(1).length).toBeGreaterThan(0);
    for (const [stage, count] of rows.slice(1)) {
      expect(stage?.length).toBeGreaterThan(0);
      expect(Number.isFinite(Number(count))).toBe(true);
    }
    for (const fixture of [image, document, runbook, spreadsheet]) {
      expect(fixture.name).toMatch(/\.(png|pdf|txt|csv)$/u);
      expect(fixture.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it('rejects unsupported fixtures instead of guessing at files outside the package', () => {
    expect(() => asset('unknown')).toThrow(/unknown/u);
    expect(() => asset('../other')).toThrow(/unknown/u);
  });

  it('gives the small profile named, varied profiles and local PNG avatars', () => {
    const names = Array.from({ length: 5 }, (_, i) => profile(username(i), i));
    expect(new Set(names.map((p) => p.name)).size).toBe(5);
    for (const person of names) {
      expect(person.name).toContain(' ');
      expect(person.bio).toContain('INC-4821');
    }
    const avatars = Array.from({ length: 5 }, (_, i) => avatar(i));
    for (const bytes of avatars)
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(new Set(avatars.map((bytes) => bytes.toString('base64'))).size).toBe(5);
  });
});
