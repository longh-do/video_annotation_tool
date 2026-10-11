/**
 * Crash recovery. Every change is written to IndexedDB at once — before the debounced save — and
 * settled when the server confirms it, so a reload after a crash, a closed tab or a lost
 * connection finds the unsaved edits. Writes use strict durability: Chrome's default is relaxed,
 * which can lose the last writes in a crash.
 *
 * IndexedDB can be unavailable (private windows, blocked site data); the tool then works as
 * before, without the safety net.
 */
import type { SavePayload } from '../core/api-types.ts';

export interface JournalEntry {
  readonly recordingId: string;
  /** The server revision these edits were made on top of. */
  readonly baseRevision: number;
  readonly payload: SavePayload;
  /**
   * The save that was on its way to the server when this entry was written, if any. If it
   * landed but the page died before hearing so, the server is one revision ahead with exactly
   * this content, and the entry still applies on top of it.
   */
  readonly inFlight: SavePayload | null;
  /** When it was written (ms since the epoch); also tells entries apart. */
  readonly writtenAt: number;
}

/** What the saver needs from the journal. */
export interface UnsavedChanges {
  write(entry: JournalEntry): Promise<void>;
  /**
   * The server saved the change written at `writtenAt` as `revision`: forget it, or, if a newer
   * change was written meanwhile, record that the newer one now builds on `revision`. Atomic.
   */
  settle(recordingId: string, writtenAt: number, revision: number): Promise<void>;
  /** Drops the entry written at `writtenAt` (unless a newer one replaced it): it can't be saved. */
  forget(recordingId: string, writtenAt: number): Promise<void>;
}

const DATABASE = 'annotation-journal';
const STORE = 'unsaved';

export class Journal implements UnsavedChanges {
  readonly #db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.#db = db;
  }

  /** The journal, or null where IndexedDB can't be used. */
  static async open(): Promise<Journal | null> {
    try {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: 'recordingId' });
      };
      return new Journal(await result(request));
    } catch {
      return null;
    }
  }

  write(entry: JournalEntry): Promise<void> {
    const { store, done } = this.#transaction('readwrite');
    store.put(entry);
    return done;
  }

  async read(recordingId: string): Promise<JournalEntry | null> {
    const { store, done } = this.#transaction('readonly');
    const entry = result<JournalEntry | undefined>(store.get(recordingId));
    await done;
    return (await entry) ?? null;
  }

  settle(recordingId: string, writtenAt: number, revision: number): Promise<void> {
    const { store, done } = this.#transaction('readwrite');
    const get = store.get(recordingId);
    get.onsuccess = () => {
      const entry = get.result as JournalEntry | undefined;
      if (!entry) return;
      if (entry.writtenAt <= writtenAt) store.delete(recordingId);
      else store.put({ ...entry, baseRevision: revision, inFlight: null });
    };
    return done;
  }

  forget(recordingId: string, writtenAt: number): Promise<void> {
    const { store, done } = this.#transaction('readwrite');
    const get = store.get(recordingId);
    get.onsuccess = () => {
      const entry = get.result as JournalEntry | undefined;
      if (entry && entry.writtenAt <= writtenAt) store.delete(recordingId);
    };
    return done;
  }

  #transaction(mode: IDBTransactionMode): { store: IDBObjectStore; done: Promise<void> } {
    const transaction = this.#db.transaction(STORE, mode, { durability: 'strict' });
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return { store: transaction.objectStore(STORE), done };
  }
}

function result<T>(request: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}
