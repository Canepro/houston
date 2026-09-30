/**
 * The journal registry, and the note it must not lose.
 *
 * `CLUSTER_UNFINISHED` is the most expensive note in the product: it is written before
 * `eksctl create cluster` and cleared only once eksctl returns, so the one case it exists
 * for is the process not getting there. A dropped note is not a missing log line -- it is
 * the only record that something billable may exist.
 */
import {
  CLUSTER_UNFINISHED,
  clearJournal,
  clearPendingPredicates,
  installJournalSink,
  journalSinkInstalled,
  recordJournal,
  registerSubjectPredicate,
  type JournalSink,
} from '../../src/lib/journal';

/** Everything written to stderr while `body` ran. */
function capturing(body: () => void): string {
  const written: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    body();
  } finally {
    process.stderr.write = real;
  }
  return written.join('');
}

function recorder(): { sink: JournalSink; seen: unknown[][]; cleared: string[] } {
  const seen: unknown[][] = [];
  const cleared: string[] = [];
  return {
    seen,
    cleared,
    sink: {
      record: (kind, workspace, detail) => {
        seen.push([kind, workspace, detail]);
        return `entry-${String(seen.length)}`;
      },
      clear: (id) => cleared.push(id),
      registerSubjectPredicate: () => undefined,
    },
  };
}

afterEach(() => {
  clearPendingPredicates();
});

describe('with a journal installed', () => {
  it('hands the note over and returns its id', () => {
    const { sink, seen, cleared } = recorder();
    const remove = installJournalSink(sink);
    try {
      expect(journalSinkInstalled()).toBe(true);
      const id = recordJournal(CLUSTER_UNFINISHED, 'support', {
        region: 'eu-west-1',
        account: '1234',
      });
      expect(id).toBe('entry-1');
      expect(seen).toEqual([
        [CLUSTER_UNFINISHED, 'support', { region: 'eu-west-1', account: '1234' }],
      ]);
      clearJournal(id);
      expect(cleared).toEqual(['entry-1']);
    } finally {
      remove();
    }
    expect(journalSinkInstalled()).toBe(false);
  });

  it('writes nothing to stderr, because the journal has it', () => {
    const { sink } = recorder();
    const remove = installJournalSink(sink);
    try {
      expect(capturing(() => recordJournal(CLUSTER_UNFINISHED, 'support'))).toBe('');
    } finally {
      remove();
    }
  });

  it('SHOUTS rather than losing the note when the journal throws', () => {
    // A journal that cannot be written must not stop the operation it was describing --
    // that is earlier releases' own rule -- but it must not swallow the note either.
    const remove = installJournalSink({
      record: () => {
        throw new Error('disk full');
      },
      clear: () => undefined,
      registerSubjectPredicate: () => undefined,
    });
    try {
      const said = capturing(() =>
        recordJournal(CLUSTER_UNFINISHED, 'support', { region: 'eu-west-1' }),
      );
      expect(said).toContain('houston.journal');
      expect(said).toContain('support');
      expect(said).toContain('eu-west-1');
    } finally {
      remove();
    }
  });

  it('does not let a failed clear fail the operation that succeeded', () => {
    const remove = installJournalSink({
      record: () => 'entry-1',
      clear: () => {
        throw new Error('read-only');
      },
      registerSubjectPredicate: () => undefined,
    });
    try {
      expect(() => clearJournal('entry-1')).not.toThrow();
    } finally {
      remove();
    }
  });

  it('removes only its own sink, so nested installs do not clobber each other', () => {
    const first = recorder();
    const second = recorder();
    const removeFirst = installJournalSink(first.sink);
    const removeSecond = installJournalSink(second.sink);
    removeFirst(); // now stale: it must not uninstall the second
    try {
      recordJournal(CLUSTER_UNFINISHED, 'support');
      expect([first.seen.length, second.seen.length]).toEqual([0, 1]);
    } finally {
      removeSecond();
    }
  });
});

describe('with none installed', () => {
  it('WRITES THE NOTE to stderr rather than dropping it', () => {
    // A dropped CLUSTER_UNFINISHED note is the only record that something billable may
    // exist, written precisely for the case where the process does not survive to say so.
    const said = capturing(() =>
      recordJournal(CLUSTER_UNFINISHED, 'support', { region: 'eu-west-1' }),
    );
    const [tag, kind, subject, detail] = said.trim().split('\t');
    expect(tag).toBe('houston.journal');
    expect(kind).toBe(CLUSTER_UNFINISHED);
    expect(subject).toBe('support');
    expect(JSON.parse(String(detail))).toEqual({ region: 'eu-west-1' });
  });

  it('returns an empty id, which a clear treats as nothing to do', () => {
    // Earlier releases' record returns '' for an unwritable directory too, and a clear of
    // '' is a no-op there for the same reason.
    const id = capturing(() => recordJournal(CLUSTER_UNFINISHED, 'support')) && '';
    expect(recordJournal(CLUSTER_UNFINISHED, 'support')).toBe('');
    expect(() => clearJournal(id)).not.toThrow();
  });

  it('writes a dash for a subject it was not given', () => {
    const said = capturing(() => recordJournal(CLUSTER_UNFINISHED, ''));
    expect(said.trim().split('\t')[2]).toBe('-');
  });

  it('survives a detail that cannot be serialised', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const said = capturing(() => recordJournal(CLUSTER_UNFINISHED, 'support', cyclic));
    expect(said).toContain('houston.journal');
    expect(said.trim().split('\t')[3]).toBe('{}');
  });
});

describe('a subject predicate registered before the journal exists', () => {
  it('is QUEUED and replayed, because recovery needs it to tell stale from live', () => {
    // It runs at module scope, as it did in earlier releases -- `core/eks.ts` registers one
    // the moment it is imported, which is before `core/journal` could have installed one.
    // Losing it would leave recovery unable to ask whether a note's subject still exists,
    // which turns a stale note into a permanent false alarm.
    const registered: string[] = [];
    registerSubjectPredicate(CLUSTER_UNFINISHED, () => true);
    registerSubjectPredicate('other_kind', () => false);
    const remove = installJournalSink({
      record: () => '',
      clear: () => undefined,
      registerSubjectPredicate: (kind) => registered.push(kind),
    });
    try {
      expect(registered).toEqual([CLUSTER_UNFINISHED, 'other_kind']);
      // And one registered AFTER the sink arrives goes straight through.
      registerSubjectPredicate('later_kind', () => true);
      expect(registered).toEqual([CLUSTER_UNFINISHED, 'other_kind', 'later_kind']);
    } finally {
      remove();
    }
  });

  it('does not replay the same queue into a second journal', () => {
    // The queue is drained on install: a second sink gets what was registered after the
    // first, not the whole history again.
    registerSubjectPredicate(CLUSTER_UNFINISHED, () => true);
    const first: string[] = [];
    const removeFirst = installJournalSink({
      record: () => '',
      clear: () => undefined,
      registerSubjectPredicate: (kind) => first.push(kind),
    });
    removeFirst();
    const second: string[] = [];
    const removeSecond = installJournalSink({
      record: () => '',
      clear: () => undefined,
      registerSubjectPredicate: (kind) => second.push(kind),
    });
    try {
      expect([first, second]).toEqual([[CLUSTER_UNFINISHED], []]);
    } finally {
      removeSecond();
    }
  });
});
