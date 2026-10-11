import type { JournalEntry, UnsavedChanges } from '../../../src/web/journal.ts';

/**
 * An in-memory journal for one recording, for the saver's tests: `log` has every state it went
 * through. The journal's own tests run the same rules on it as on the IndexedDB one, so the two
 * can't drift apart.
 */
export function memoryJournal() {
  let entry: JournalEntry | null = null;
  const log: (JournalEntry | null)[] = [];
  const journal: UnsavedChanges & {
    readonly entry: JournalEntry | null;
    readonly log: typeof log;
    read(recordingId: string): Promise<JournalEntry | null>;
  } = {
    get entry() {
      return entry;
    },
    log,
    read: async (recordingId) => (entry?.recordingId === recordingId ? entry : null),
    write: async (written) => {
      entry = written;
      log.push(entry);
    },
    settle: async (recordingId, writtenAt, revision) => {
      if (entry?.recordingId !== recordingId) return;
      if (entry.writtenAt <= writtenAt) entry = null;
      else entry = { ...entry, baseRevision: revision, inFlight: null };
      log.push(entry);
    },
    forget: async (recordingId, writtenAt) => {
      if (entry?.recordingId !== recordingId) return;
      if (entry.writtenAt <= writtenAt) entry = null;
      log.push(entry);
    },
  };
  return journal;
}
