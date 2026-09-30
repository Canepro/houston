import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  MONGO8_BAD_KERNEL,
  kernelMajorMinor,
  mongoKernelConflict,
} from '../../src/lib/mongo-kernel';

/**
 * What earlier releases answered for every KERNELS x TAGS pair below, recorded: the conflict
 * message per tag and kernel, the major.minor read off each kernel, and the bad kernel.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'lib', 'mongo-kernel.json'), 'utf8'),
) as {
  conflict: string[][];
  kernel: ([number, number] | null)[];
  bad: [number, number];
};

/** The boundary the rule is named for, plus the shapes a real kernel probe hands over. */
const KERNELS = [
  '6.19',
  '6.19.7',
  '6.18.9',
  '6.20',
  '5.15.0-1092-aws',
  '7.0',
  '',
  'garbage',
  '6.19RC1',
  '  6.19.7  ',
];

const TAGS = ['8.0', '8.0.4', '7.0', '6.0', '8', '8abc', '', 'latest'];

describe('the MongoDB/kernel rule', () => {
  it('reads a major.minor off the front of the kernel string, or null', () => {
    expect(kernelMajorMinor('6.19.7')).toEqual([6, 19]);
    expect(kernelMajorMinor('6.19')).toEqual([6, 19]);
    expect(kernelMajorMinor('garbage')).toBeNull();
    expect(kernelMajorMinor('')).toBeNull();
    expect(kernelMajorMinor(null)).toBeNull();
    // The read anchors at the START: `1.2 x 6.19` is engine 1.2, not 6.19.
    expect(kernelMajorMinor('6.19RC1')).toEqual([6, 19]);
  });

  it('refuses exactly the pair SERVER-121912 describes', () => {
    expect(mongoKernelConflict('8.0', '6.19.7')).toContain('SERVER-121912');
    expect(mongoKernelConflict('8.0.4', '6.19')).toContain('SERVER-121912');
    // MongoDB < 8 is fine on any kernel.
    expect(mongoKernelConflict('7.0', '6.19.7')).toBe('');
    // Kernel < 6.19 is fine with any MongoDB.
    expect(mongoKernelConflict('8.0', '6.18.9')).toBe('');
    expect(mongoKernelConflict('8.0', '5.15.0-1092-aws')).toBe('');
    // Unreadable on either side is "no conflict", never a guessed one.
    expect(mongoKernelConflict('8.0', 'garbage')).toBe('');
    expect(mongoKernelConflict('8.0', '')).toBe('');
    expect(mongoKernelConflict('latest', '6.19.7')).toBe('');
    expect(mongoKernelConflict('8abc', '6.19.7')).toBe('');
  });

  it('says which tag and which kernel, because mongod itself says neither', () => {
    const message = mongoKernelConflict('8.0', '6.19.7');
    expect(message).toContain('MongoDB 8.0');
    expect(message).toContain('6.19');
  });

  it('is byte-identical to earlier releases across every pair', () => {
    expect(KERNELS.map(kernelMajorMinor)).toEqual(RECORDED.kernel);
    expect(TAGS.map((t) => KERNELS.map((k) => mongoKernelConflict(t, k)))).toEqual(
      RECORDED.conflict,
    );
    expect([...MONGO8_BAD_KERNEL]).toEqual(RECORDED.bad);
  });
});
