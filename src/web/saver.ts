/**
 * Saving: every change is kept in the journal at once and goes to the server shortly after
 * (debounced), one request at a time, always the newest version. The status says exactly where
 * things stand, for the save chip.
 *
 * A save whose answer never comes (the connection dropped) may have landed. Until that is known
 * it is sent again before anything newer, and journal entries name it, so that newer changes
 * still reopen on top of it.
 */
import type { SavePayload } from '../core/api-types.ts';
import { ApiError, fetchSaved, saveAnnotation } from './api.ts';
import type { JournalEntry, UnsavedChanges } from './journal.ts';
import { sameContent } from './persistence.ts';

export type SaveStatus =
  | { readonly kind: 'saved' }
  | { readonly kind: 'saving' }
  /**
   * The change didn't get through and is retried. `serverError` is what the server answered, or
   * null when it can't be reached; `kept` says whether the journal on this computer has it.
   */
  | { readonly kind: 'offline'; readonly serverError: string | null; readonly kept: boolean }
  /** Someone saved a newer revision (another tab): stop, and reload. */
  | { readonly kind: 'conflict' }
  /** The server refused the content: a bug, not something the annotator can fix. */
  | { readonly kind: 'rejected'; readonly problems: readonly string[] };

/** A change is sent once changes pause this long… */
const SAVE_DELAY_MS = 300;
/** …or at the latest this long after it was made, even while changes keep coming. */
const MAX_SAVE_DELAY_MS = 2000;
const MAX_RETRY_MS = 10_000;

interface Change {
  readonly payload: SavePayload;
  /** When it was (or will be) written to the journal; also tells changes apart. */
  readonly writtenAt: number;
  /** In the journal yet: a held key's repeats are written once, when they are sent. */
  journaled: boolean;
}

export class Saver {
  readonly #recordingId: string;
  /** Not used again once a call fails: its data was cleared, or it can't be written. */
  #journal: UnsavedChanges | null;
  readonly #listeners = new Set<() => void>();
  #revision: number;
  #status: SaveStatus;
  /** The newest change not sent yet. */
  #pending: Change | null = null;
  /** The change sent last, until its answer comes: without one, it may be on the server. */
  #unanswered: Change | null = null;
  /** When the oldest change not sent yet was made. */
  #pendingSince: number | null = null;
  #lastWrittenAt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | null = null;
  /** The page is being hidden or closed: what is sent must outlive it. */
  #keepalive = false;
  #retryMs = 1000;

  constructor(recordingId: string, revision: number, journal: UnsavedChanges | null = null) {
    this.#recordingId = recordingId;
    this.#revision = revision;
    this.#status = { kind: 'saved' };
    this.#journal = journal;
  }

  get status(): SaveStatus {
    return this.#status;
  }

  get revision(): number {
    return this.#revision;
  }

  /** Something isn't on the server yet. */
  get dirty(): boolean {
    return this.#pending !== null || this.#unanswered !== null || this.#status.kind === 'saving';
  }

  /** Saving has stopped and won't resume without a reload (conflict or refused content). */
  get stopped(): boolean {
    return this.#status.kind === 'conflict' || this.#status.kind === 'rejected';
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * Journals the newest version at once (or, with `journalNow` false, once it is sent); it is
   * sent once changes pause for a moment, and never later than MAX_SAVE_DELAY_MS after the oldest
   * change waiting.
   */
  save(payload: SavePayload, journalNow = true): void {
    const now = Date.now();
    // Strictly increasing, so the journal can tell two quick changes apart.
    const writtenAt = Math.max(now, this.#lastWrittenAt + 1);
    this.#lastWrittenAt = writtenAt;
    this.#pending = { payload, writtenAt, journaled: false };
    this.#pendingSince ??= now;
    if (journalNow) this.#write(this.#pending);
    // Not on the server yet: the chip must not say "saved" meanwhile.
    if (this.#status.kind === 'saved') this.#setStatus({ kind: 'saving' });
    clearTimeout(this.#timer);
    const latest = this.#pendingSince + MAX_SAVE_DELAY_MS - now;
    this.#timer = setTimeout(() => void this.flush(), Math.min(SAVE_DELAY_MS, latest));
  }

  /**
   * Sends anything pending now; resolves true once everything is saved. With `keepalive` the
   * requests outlive the page, for when it is being hidden or closed; a save already running
   * sends the rest that way too.
   */
  async flush(keepalive = false): Promise<boolean> {
    clearTimeout(this.#timer);
    if (keepalive) this.#keepalive = true;
    this.#running ??= this.#sendPending().finally(() => {
      this.#running = null;
      this.#keepalive = false;
    });
    await this.#running;
    return this.#pending === null && this.#unanswered === null && this.#status.kind === 'saved';
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#listeners.clear();
  }

  async #sendPending(): Promise<void> {
    while (!this.stopped) {
      // A save whose answer never came goes first: if it landed, newer changes build on it.
      const sending = this.#unanswered ?? this.#pending;
      if (!sending) return;
      if (sending === this.#pending) {
        this.#pending = null;
        this.#pendingSince = null;
        if (!sending.journaled) this.#write(sending);
      }
      this.#unanswered = sending;
      this.#setStatus({ kind: 'saving' });
      const revision = await this.#send(sending);
      if (revision === null) return;
      this.#unanswered = null;
      this.#revision = revision;
      this.#retryMs = 1000;
      // After the save, outside its error handling: a journal that fails can't undo it.
      this.#useJournal((journal) => journal.settle(this.#recordingId, sending.writtenAt, revision));
      this.#setStatus({ kind: 'saved' });
    }
  }

  /** Sends a change; its revision once saved, or null when saving stopped or waits to retry. */
  async #send(change: Change): Promise<number | null> {
    const id = this.#recordingId;
    try {
      return (await saveAnnotation(id, this.#revision, change.payload, this.#keepalive)).revision;
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) return this.#landedBefore(change);
      if (error instanceof ApiError && error.status === 400) {
        // Refused content would be refused again after every reload: drop it from the journal.
        this.#useJournal((journal) => journal.forget(id, change.writtenAt));
        return this.#stop({ kind: 'rejected', problems: error.body.problems ?? [error.message] });
      }
      return this.#retryLater(error);
    }
  }

  /**
   * The server is ahead. If it has exactly this change, an earlier try landed and only its
   * answer was lost: that revision is ours. Otherwise someone else saved.
   */
  async #landedBefore(change: Change): Promise<number | null> {
    try {
      const server = await fetchSaved(this.#recordingId);
      if (sameContent(server.saved, change.payload)) return server.revision;
      return this.#stop({ kind: 'conflict' });
    } catch (error) {
      return this.#retryLater(error);
    }
  }

  /** No answer, or one that says nothing about the change: it is kept and sent again later. */
  #retryLater(error: unknown): null {
    // What waits behind it must be kept now too: a held key's repeats are journaled when sent.
    if (this.#pending && !this.#pending.journaled) this.#write(this.#pending);
    const serverError = error instanceof ApiError ? error.message : null;
    this.#setStatus({ kind: 'offline', serverError, kept: this.#journal !== null });
    this.#timer = setTimeout(() => void this.flush(), this.#retryMs);
    this.#retryMs = Math.min(this.#retryMs * 2, MAX_RETRY_MS);
    return null;
  }

  #stop(status: Extract<SaveStatus, { kind: 'conflict' | 'rejected' }>): null {
    this.#unanswered = null;
    this.#setStatus(status);
    return null;
  }

  /** Puts a change in the journal, on top of the revision it will be saved on. */
  #write(change: Change): void {
    change.journaled = true;
    const entry: JournalEntry = {
      recordingId: this.#recordingId,
      baseRevision: this.#revision,
      payload: change.payload,
      inFlight: this.#unanswered?.payload ?? null,
      writtenAt: change.writtenAt,
    };
    this.#useJournal((journal) => journal.write(entry));
  }

  /** Runs a journal call. One that fails, even by throwing, never affects saving. */
  #useJournal(call: (journal: UnsavedChanges) => Promise<void>): void {
    const journal = this.#journal;
    if (!journal) return;
    const failed = () => {
      if (this.#journal !== journal) return;
      this.#journal = null;
      if (this.#status.kind === 'offline') this.#setStatus({ ...this.#status, kept: false });
    };
    try {
      call(journal).catch(failed);
    } catch {
      failed();
    }
  }

  #setStatus(status: SaveStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener();
  }
}
