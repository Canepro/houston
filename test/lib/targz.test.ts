import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import {
  Interrupted,
  interrupt,
  resetInterruptForTest,
  unwindsOnInterrupt,
} from '../../src/seams/exec';

import { ValidationError } from '../../src/lib/errors';
import {
  UnsafeBundleEntry,
  extractTarGz,
  memberNames,
  readMember,
  writeTarGzFromDir,
} from '../../src/lib/targz';

/**
 * Bundles earlier releases wrote, and bundles this build wrote that earlier releases read
 * back as the listings asserted below, recorded as base64; the sha256 of a tar stream built
 * here that earlier releases read back; and a refusal they raised, with `{DIR}` for the
 * directory it names.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'lib', 'targz.json'), 'utf8'),
) as {
  long_names_bundle: string;
  base256_tar_sha256: string;
  pax_size_bundle: string;
  unsafe_bundle: string;
  written_bundle: string;
  long_name_written_bundle: string;
  packed_bundle: string;
  readonly_refusal: { kind: string; message: string };
};

/** A recorded bundle's bytes. */
function recordedBytes(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}

/**
 * A tar stream with every header's owner fields -- uid, gid, user and group name -- and
 * its checksum zeroed, after checking that checksum holds. The owner is the account a
 * stream was written by, so it is the one part of a recorded stream no other machine can
 * reproduce; everything else must match byte for byte.
 */
function ownershipBlanked(tar: Buffer): Buffer {
  const out = Buffer.from(tar);
  let at = 0;
  while (at + 512 <= out.length) {
    const block = out.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (block[i] as number);
    const stored = block
      .subarray(148, 156)
      .toString('latin1')
      .replace(/[\0 ]+$/u, '');
    expect([at, Number.parseInt(stored, 8)]).toEqual([at, sum]);
    const size = Number.parseInt(block.subarray(124, 136).toString('latin1'), 8);
    for (const [start, end] of [
      [108, 124],
      [148, 156],
      [265, 329],
    ] as const)
      block.fill(0, start, end);
    at += 512 * (1 + Math.ceil(size / 512));
  }
  return out;
}

/**
 * Set a path's own mtime -- a symlink's, not its target's -- to `seconds.nanoseconds`
 * exactly, which `fs.utimesSync` cannot.
 */
function setMtimeNs(target: string, nanoseconds: bigint): void {
  const seconds = nanoseconds / 1_000_000_000n;
  const fraction = (nanoseconds % 1_000_000_000n).toString().padStart(9, '0');
  const ran = spawnSync('touch', ['-h', '-m', '-d', `@${String(seconds)}.${fraction}`, target], {
    encoding: 'utf8',
  });
  expect(ran.stderr).toBe('');
  expect(ran.status).toBe(0);
}

/** Run `make` under a 022 umask, the one the recorded bundles' staging trees were made under. */
function underRecordedUmask<T>(make: () => T): T {
  const saved = process.umask(0o022);
  try {
    return make();
  } finally {
    process.umask(saved);
  }
}

/** Every entry under `root`, and `root` itself, at one fixed whole-second mtime. */
function pinMtimes(root: string): void {
  for (const entry of fs.readdirSync(root, { recursive: true }))
    fs.utimesSync(path.join(root, String(entry)), 1, 1_790_000_000);
  fs.utimesSync(root, 1, 1_790_000_000);
}

/**
 * The staging tree the pack is compared on: every member kind a bundle can hold -- nested
 * directories at two modes, an empty file, one of exactly one block, a binary one, a
 * non-ASCII name past 100 bytes, a symlink, a hard link and a fifo -- each at its own
 * nanosecond mtime: the files by the directory they sit in, the symlink and the fifo apart,
 * and the directories deepest first.
 */
function makePackStaging(staging: string): void {
  underRecordedUmask(() => {
    fs.mkdirSync(path.join(staging, 'files', 'monitoring', 'grafana'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'manifest.json'), '{"schema": 1}');
    const pattern = Buffer.from([...Array(256).keys()]);
    fs.writeFileSync(
      path.join(staging, 'mongo.archive.gz'),
      Buffer.concat(Array<Buffer>(300).fill(pattern)),
    );
    fs.writeFileSync(path.join(staging, 'compose.yml'), 'services: {}\n');
    fs.writeFileSync(path.join(staging, 'files', 'exact-512'), Buffer.alloc(512, 'x'));
    fs.writeFileSync(path.join(staging, 'files', 'empty'), '');
    fs.writeFileSync(path.join(staging, 'files', `café-${'x'.repeat(120)}.txt`), 'long');
    fs.writeFileSync(path.join(staging, 'files', 'monitoring', 'grafana', 'dash.json'), '{}');
    fs.chmodSync(path.join(staging, 'files', 'exact-512'), 0o640);
    fs.symlinkSync('dash.json', path.join(staging, 'files', 'monitoring', 'grafana', 'link'));
    fs.linkSync(path.join(staging, 'compose.yml'), path.join(staging, 'files', 'hard.yml'));
    const fifo = spawnSync('mkfifo', [path.join(staging, 'files', 'pipe')], { encoding: 'utf8' });
    expect(fifo.status).toBe(0);
    fs.chmodSync(path.join(staging, 'files', 'monitoring'), 0o750);
  });
  const dirs = ['', 'files', 'files/monitoring', 'files/monitoring/grafana'];
  const files: Record<string, string[]> = {
    '': ['compose.yml', 'manifest.json', 'mongo.archive.gz'],
    files: [`café-${'x'.repeat(120)}.txt`, 'empty', 'exact-512', 'hard.yml'],
    'files/monitoring': [],
    'files/monitoring/grafana': ['dash.json'],
  };
  dirs.forEach((dir, at) => {
    for (const name of files[dir] ?? [])
      setMtimeNs(path.join(staging, dir, name), 1_790_000_000_123_456_789n + BigInt(at));
  });
  setMtimeNs(
    path.join(staging, 'files', 'monitoring', 'grafana', 'link'),
    1_790_000_000_555_555_555n,
  );
  setMtimeNs(path.join(staging, 'files', 'pipe'), 1_790_000_000_000_000_777n);
  [...dirs].reverse().forEach((dir, at) => {
    setMtimeNs(path.join(staging, dir), 1_790_000_000_987_654_321n + BigInt(at));
  });
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function collect(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir).sort()) {
    const absolute = path.join(dir, entry);
    const relative = prefix === '' ? entry : `${prefix}/${entry}`;
    if (fs.statSync(absolute).isDirectory()) Object.assign(out, collect(absolute, relative));
    else out[relative] = fs.readFileSync(absolute).toString('utf8');
  }
  return out;
}

describe('reading a bundle an earlier release wrote', () => {
  it('reads members and extracts the tree, long names included', async () => {
    const dir = tempDir('houston-targz-earlier-');
    const bundle = path.join(dir, 'bundle.rcbak');
    try {
      // Earlier releases write PAX by default, and a >100-character name forces a PAX
      // `path` record -- the mechanism a naive ustar reader would miss. The bundle is the
      // one an earlier release wrote from manifest.json, files/a.txt and that long name.
      const longName = `${'l'.repeat(120)}.txt`;
      fs.writeFileSync(bundle, recordedBytes(RECORDED.long_names_bundle));

      const manifest = await readMember(bundle, 'manifest.json');
      expect(manifest).not.toBeNull();
      expect(JSON.parse(String(manifest))).toEqual({ schema: 1, x: 'y' });
      const names = await memberNames(bundle);
      expect(names).toContain('files/a.txt');
      expect(names).toContain(`files/deep/${longName}`);

      const out = tempDir('houston-targz-out-');
      try {
        await extractTarGz(bundle, out);
        expect(collect(out)).toEqual({
          'manifest.json': '{"schema": 1, "x": "y"}',
          'files/a.txt': 'alpha',
          [`files/deep/${longName}`]: 'long',
        });
      } finally {
        fs.rmSync(out, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a GNU base-256 size field, which earlier releases write above 8 GiB', async () => {
    const dir = tempDir('houston-targz-b256-');
    const bundle = path.join(dir, 'base256.rcbak');
    try {
      // A member whose size is encoded in GNU base-256 rather than octal. Earlier releases
      // write this shape for any member at or above 8 GiB (a large gzipped Mongo archive),
      // and reading those bytes as octal text silently answered 0.
      const body = Buffer.from('{"schema": 1, "base": 256}');
      const block = Buffer.alloc(512);
      block.write('manifest.json', 0, 'utf8');
      block.write('0000644\0', 100, 8, 'ascii');
      block.write('0000000\0', 108, 8, 'ascii');
      block.write('0000000\0', 116, 8, 'ascii');
      block[124] = 0x80;
      let remaining = body.length;
      for (let at = 135; at >= 125; at -= 1) {
        block[at] = remaining & 0xff;
        remaining = Math.floor(remaining / 256);
      }
      block.write('00000000000\0', 136, 12, 'ascii');
      block.write('        ', 148, 8, 'ascii');
      block.write('0', 156, 1, 'ascii');
      block.write('ustar\0', 257, 6, 'ascii');
      block.write('00', 263, 2, 'ascii');
      let checksum = 0;
      for (const byte of block) checksum += byte;
      block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
      const pad = (512 - (body.length % 512)) % 512;
      const padded = Buffer.concat([block, body, Buffer.alloc(pad)]);
      const stream = Buffer.concat([padded, Buffer.alloc(1024)]);
      const gz = zlib.gzipSync(stream);
      fs.writeFileSync(bundle, gz);

      const mine = await readMember(bundle, 'manifest.json');
      expect(JSON.parse(String(mine))).toEqual({ schema: 1, base: 256 });

      // Earlier releases read exactly this stream back as the same manifest, recorded; the
      // hash says the stream is still the one they read.
      const recorded = { schema: 1, base: 256 };
      expect(createHash('sha256').update(stream).digest('hex')).toBe(RECORDED.base256_tar_sha256);
      expect(JSON.parse(String(mine))).toEqual(recorded);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a PAX size record, which earlier releases write above 8 GiB by default', async () => {
    // PAX, houston's bundles' format, writes the ustar size field as 0 for a member of
    // 8 GiB or more and the real size as a PAX `size` record. The walker read only the PAX
    // `path`, so such a bundle was a zero-length member followed by archive bytes read as
    // headers: UNREADABLE, where earlier releases list and restore it. The bundle is the one
    // an earlier release wrote, then the ustar size field zeroed as the 8-GiB branch leaves
    // it; that release read it back as the manifest and `still here`, recorded.
    const dir = tempDir('houston-targz-pax-');
    const bundle = path.join(dir, 'pax.rcbak');
    try {
      fs.writeFileSync(bundle, recordedBytes(RECORDED.pax_size_bundle));
      const manifest = await readMember(bundle, 'manifest.json');
      expect(JSON.parse(String(manifest))).toEqual({ schema: 1, pax: 'size' });
      expect(String(await readMember(bundle, 'after.txt'))).toBe('still here');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unsafe member before it can escape the staging directory', async () => {
    const dir = tempDir('houston-targz-evil-');
    const bundle = path.join(dir, 'evil.rcbak');
    try {
      // The bundle an earlier release wrote holding `ok.txt` and `../escape.txt`.
      fs.writeFileSync(bundle, recordedBytes(RECORDED.unsafe_bundle));
      await expect(memberNames(bundle)).rejects.toBeInstanceOf(UnsafeBundleEntry);
      // Earlier releases refuse it as a `ValidationError`, so the refusal IS the error
      // contract (an `http_status`, not a bare Error), and the name is quoted as they quote.
      const failure = await memberNames(bundle).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ValidationError);
      expect((failure as Error).message).toBe("bundle contains an unsafe entry: '../escape.txt'");
      const out = tempDir('houston-targz-evil-out-');
      try {
        await expect(extractTarGz(bundle, out)).rejects.toBeInstanceOf(UnsafeBundleEntry);
        expect(fs.existsSync(path.join(os.tmpdir(), 'escape.txt'))).toBe(false);
      } finally {
        fs.rmSync(out, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writing a bundle earlier releases can read', () => {
  // Each bundle is held to the bytes this build wrote from the same tree when an earlier
  // release was shown to open it and list the files below -- the owner fields aside, which
  // name whoever runs the test. The tree is made under the recorded umask, at one mtime.
  it('produces an archive earlier releases open and list identically', async () => {
    const dir = tempDir('houston-targz-ts-');
    const staging = path.join(dir, 'staging');
    const bundle = path.join(dir, 'bundle.rcbak');
    try {
      underRecordedUmask(() => {
        fs.mkdirSync(path.join(staging, 'files', 'deep'), { recursive: true });
        fs.writeFileSync(path.join(staging, 'manifest.json'), '{"schema": 1}', 'utf8');
        fs.writeFileSync(path.join(staging, 'files', 'a.txt'), 'alpha', 'utf8');
        fs.writeFileSync(path.join(staging, 'files', 'deep', 'b.bin'), Buffer.from([0, 1, 2, 255]));
      });
      pinMtimes(staging);
      await writeTarGzFromDir(staging, bundle);

      const recorded = recordedBytes(RECORDED.written_bundle);
      expect(ownershipBlanked(zlib.gunzipSync(fs.readFileSync(bundle)))).toEqual(
        ownershipBlanked(zlib.gunzipSync(recorded)),
      );
      // What earlier releases listed from those bytes, file by file.
      const listed = {
        'files/a.txt': Buffer.from('alpha').toString('hex'),
        'files/deep/b.bin': '000102ff',
        'manifest.json': Buffer.from('{"schema": 1}').toString('hex'),
      };
      const ours: Record<string, string> = {};
      for (const name of Object.keys(listed))
        ours[name] = Buffer.from((await readMember(bundle, name)) ?? '').toString('hex');
      expect(ours).toEqual(listed);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a >100-byte name as a long-name member earlier releases can read', async () => {
    const dir = tempDir('houston-targz-longwrite-');
    const staging = path.join(dir, 'staging');
    const bundle = path.join(dir, 'bundle.rcbak');
    try {
      const longName = `${'w'.repeat(120)}.txt`;
      underRecordedUmask(() => {
        fs.mkdirSync(path.join(staging, 'files', 'deep'), { recursive: true });
        fs.writeFileSync(path.join(staging, 'manifest.json'), '{"schema": 1}', 'utf8');
        fs.writeFileSync(path.join(staging, 'files', 'deep', longName), 'long-body', 'utf8');
      });
      pinMtimes(staging);
      await writeTarGzFromDir(staging, bundle);

      // OUR OWN READER FIRST, then the recorded bytes: a name truncated to the 100-byte
      // ustar field would come back as a different filename on both sides.
      const names = await memberNames(bundle);
      expect(names).toContain(`files/deep/${longName}`);

      const recorded = recordedBytes(RECORDED.long_name_written_bundle);
      expect(ownershipBlanked(zlib.gunzipSync(fs.readFileSync(bundle)))).toEqual(
        ownershipBlanked(zlib.gunzipSync(recorded)),
      );
      // What earlier releases read from those bytes, file by file.
      const listed = {
        'manifest.json': '{"schema": 1}',
        [`files/deep/${longName}`]: 'long-body',
      };
      const ours: Record<string, string> = {};
      for (const name of Object.keys(listed))
        ours[name] = String((await readMember(bundle, name)) ?? '');
      expect(ours).toEqual(listed);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves no partial file behind when the destination already exists', async () => {
    const dir = tempDir('houston-targz-atomic-');
    const staging = path.join(dir, 'staging');
    const bundle = path.join(dir, 'bundle.rcbak');
    try {
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(path.join(staging, 'a.txt'), 'a', 'utf8');
      fs.writeFileSync(bundle, 'existing', 'utf8');
      await writeTarGzFromDir(staging, bundle);
      expect(fs.readdirSync(dir).sort()).toEqual(['bundle.rcbak', 'staging']);
      expect(fs.readFileSync(bundle).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writing a bundle as earlier releases write it', () => {
  // `writeTarGzFromDir` was a minimal ustar writer: every member 0644 -- directories too --
  // uid/gid 0 with no names, one mtime "now", no PAX records, no record padding, a gzip header
  // with no name and no time. The same staging tree was packed by an earlier release, and
  // the tar stream this build's pack decompresses to must be the bytes that one does -- the
  // owner fields aside, which name whoever runs the test; the deflate between may differ,
  // as two zlib builds do.
  it('writes the tar stream and the gzip framing earlier releases write, member for member', async () => {
    const dir = tempDir('houston-targz-astar-');
    try {
      const staging = path.join(dir, 'staging');
      makePackStaging(staging);
      const before = Math.floor(Date.now() / 1000);
      fs.mkdirSync(path.join(dir, 'ts'));
      await writeTarGzFromDir(staging, path.join(dir, 'ts', 'b.rcbak'));
      const after = Math.floor(Date.now() / 1000);
      const recorded = recordedBytes(RECORDED.packed_bundle);
      const ours = fs.readFileSync(path.join(dir, 'ts', 'b.rcbak'));
      // The header: magic, deflate, FNAME set, the .partial's name, XFL 2 for level 9, OS 255;
      // MTIME is the time of the pack, so this run's own.
      const framing = (bytes: Buffer) => {
        const end = bytes.indexOf(0, 10);
        return {
          fixed: [...bytes.subarray(0, 4), ...bytes.subarray(8, 10)],
          name: bytes.subarray(10, end).toString('latin1'),
        };
      };
      expect(framing(ours)).toEqual(framing(recorded));
      expect(framing(ours)).toEqual({
        fixed: [0x1f, 0x8b, 8, 8, 2, 0xff],
        name: 'b.rcbak.partial',
      });
      expect(ours.readUInt32LE(4)).toBeGreaterThanOrEqual(before);
      expect(ours.readUInt32LE(4)).toBeLessThanOrEqual(after);
      // `gunzipSync` checks the CRC-32 and length trailer as it goes. The CRC covers the
      // owner fields, so only the length is compared with the recorded trailer.
      const tar = zlib.gunzipSync(ours);
      expect(ownershipBlanked(tar).equals(ownershipBlanked(zlib.gunzipSync(recorded)))).toBe(true);
      expect(ours.subarray(-4).equals(recorded.subarray(-4))).toBe(true);
      expect(tar.length % 10240).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams a member larger than 2 GiB, which it read whole and could not', async () => {
    // Each member was `fs.readFileSync`, which refuses a file over 2 GiB: a large customer's
    // mongodump archive was `RangeError [ERR_FS_FILE_TOO_LARGE]` and an unhandled error
    // where earlier releases stream it. Sparse, so the file costs no disk; the member
    // after it is read back through the whole stream, so its size and padding are right.
    const dir = tempDir('houston-targz-2gib-');
    try {
      const staging = path.join(dir, 'staging');
      fs.mkdirSync(staging);
      const big = path.join(staging, 'mongo.archive.gz');
      fs.writeFileSync(big, '');
      fs.truncateSync(big, 2 ** 31 + 1);
      fs.writeFileSync(path.join(staging, 'z-after.txt'), 'still here');
      const bundle = path.join(dir, 'b.rcbak');
      await writeTarGzFromDir(staging, bundle);
      expect(String(await readMember(bundle, 'z-after.txt'))).toBe('still here');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('refuses an --out nobody may write into as the permission error earlier releases raise', async () => {
    // A WriteStream opened the `.partial`, and its 'error' rejected a promise nothing awaited
    // yet: the CLI died of an unhandled rejection, with no houston error line and no end
    // record in the event log. Earlier releases raise at the open, at once.
    const dir = tempDir('houston-targz-readonly-');
    const staging = path.join(dir, 'staging');
    const readonly = path.join(dir, 'ro');
    try {
      fs.mkdirSync(staging);
      fs.writeFileSync(path.join(staging, 'manifest.json'), '{}');
      fs.mkdirSync(readonly, 0o500);
      // The precondition: this process may not create a file there.
      expect(() => fs.writeFileSync(path.join(readonly, 'probe'), '')).toThrow(/EACCES/u);
      // What earlier releases raised for the same directory, recorded.
      const recorded = {
        kind: RECORDED.readonly_refusal.kind,
        message: RECORDED.readonly_refusal.message.split('{DIR}').join(readonly),
      };
      const ours = await writeTarGzFromDir(staging, path.join(readonly, 'b.rcbak')).then(
        () => null,
        (error: Error) => ({ kind: error.name, message: error.message }),
      );
      expect(ours).toEqual(recorded);
      expect(fs.readdirSync(readonly)).toEqual([]);
    } finally {
      fs.chmodSync(readonly, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a Ctrl-C while packing', () => {
  afterEach(() => resetInterruptForTest());

  it('raises in the pack and leaves neither the bundle nor its .partial, as earlier releases do', async () => {
    // Packing waited on nothing a Ctrl-C reaches, so an interrupted `backup` packed on for
    // the unwind's two-second bound and was then ended mid-pack, leaving the `.partial`
    // behind. In earlier releases the interrupt lands inside the pack loop and the pack's
    // cleanup unlinks the `.partial`, leaving nothing; here it is raised the same way.
    const dir = tempDir('houston-targz-interrupt-');
    try {
      const staging = path.join(dir, 'staging');
      fs.mkdirSync(path.join(staging, 'files'), { recursive: true });
      fs.writeFileSync(path.join(staging, 'manifest.json'), '{"schema": 1}', 'utf8');
      fs.writeFileSync(path.join(staging, 'files', 'a.txt'), 'alpha', 'utf8');
      let ended = 0;
      const packing = unwindsOnInterrupt(
        async () => await writeTarGzFromDir(staging, path.join(dir, 'b.rcbak')),
      );
      interrupt(() => (ended += 1));
      await expect(packing).rejects.toBeInstanceOf(Interrupted);
      expect(ended).toBe(0);
      // The `.partial` is opened asynchronously: a Ctrl-C at the first write used to reject
      // before the open had landed, so the `finally` removed nothing and the open then
      // created the file. Give a stray open the time to land before looking.
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Only the staging directory: no bundle and no `.partial`.
      expect(fs.readdirSync(dir)).toEqual(['staging']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
