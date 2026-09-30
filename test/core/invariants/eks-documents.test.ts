/**
 * INVARIANT: the permissions registry and the directory it names agree.
 *
 * MECHANISM: RUNTIME REGISTRY, walked against the shipped directory.
 *
 * A registry and a directory that disagree is how a document goes missing. These are
 * pasted into `aws iam create-policy` and `kubectl apply` by somebody setting houston up
 * for the first time, so an entry naming a file that is not there fails at the worst
 * possible moment -- and a file nobody lists is one nobody knows to use.
 *
 * ONE COPY ON DISK: `config.dataPath` resolves into `data/`, the directory that ships, so this
 * walk is a claim about the thing that actually ships rather than about a copy of it.
 */
import * as fs from 'node:fs';

import { dataPath } from '../../../src/lib/config';
import * as eks from '../../../src/core/eks';
import * as eksDocs from '../../../src/core/eks-docs';

describe('the IAM documents houston tells you to apply', () => {
  it('lists exactly the documents that ship', () => {
    const shipped = new Set(
      fs
        .readdirSync(dataPath('iam'), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name),
    );
    const listed = new Set(Object.values(eksDocs.IAM_DOCUMENTS).map(([file]) => file));
    expect(shipped.size).toBeGreaterThan(0);
    expect([...listed].sort()).toEqual([...shipped].sort());
    for (const key of Object.keys(eksDocs.IAM_DOCUMENTS)) {
      // Present is not the same as usable: an empty file passes every set comparison.
      expect(eksDocs.iamDocument(key).trim()).not.toBe('');
    }
  });

  it('re-exports the one implementation rather than a second copy', () => {
    // Two implementations behind one name is how the CLI and the GUI would start printing
    // different permissions for the same cluster.
    expect(eks.iamDocument).toBe(eksDocs.iamDocument);
    expect(eks.IAM_DOCUMENTS).toBe(eksDocs.IAM_DOCUMENTS);
    expect(eks.guide).toBe(eksDocs.guide);
  });

  it('refuses a key it does not list, rather than answering with nothing', () => {
    expect(() => eksDocs.iamDocument('not-a-document')).toThrow();
  });
});
