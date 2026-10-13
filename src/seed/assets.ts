/** Packaged fixtures: no network dependencies or generated claims about a version. */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dataPath } from '../lib/config';

export function asset(extension: string): {
  name: string;
  type: string;
  bytes: Buffer;
  sha256: string;
} {
  const names: Record<string, [string, string]> = {
    png: ['seed-preview.png', 'image/png'],
    txt: ['seed-runbook.txt', 'text/plain'],
    pdf: ['seed-report.pdf', 'application/pdf'],
    csv: ['seed-metrics.csv', 'text/csv'],
  };
  const pair = names[extension];
  if (pair === undefined) throw new Error('unknown packaged seed fixture');
  const bytes = fs.readFileSync(dataPath('seed', pair[0]));
  return {
    name: pair[0],
    type: pair[1],
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function avatar(index: number): Buffer {
  return fs.readFileSync(dataPath('seed', `avatar-${index % 8}.png`));
}

export function profile(username: string, index: number): { name: string; bio: string } {
  const surnames = ['Morgan', 'Patel', 'Chen', 'Hassan', 'Silva', 'Kim', 'Okafor', 'Rivera'];
  const roles = [
    'Deployment engineer',
    'Support engineer',
    'Incident coordinator',
    'Quality engineer',
  ];
  return {
    name: `${username[0]?.toUpperCase() ?? ''}${username.slice(1)} ${surnames[index % surnames.length] as string}`,
    bio: `${roles[index % roles.length] as string}. Sample account for support conversations, deployments, and INC-4821.`,
  };
}
