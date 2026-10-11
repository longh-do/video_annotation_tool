/**
 * Saving: every change is kept in the journal at once and goes to the server shortly after
 * (debounced), one request at a time, always the newest version. The status says exactly where
 * things stand, for the save chip.
 */
import type { SavePayload } from '../core/api-types.ts';
import { ApiError, saveAnnotation } from './api.ts';
import type { UnsavedChanges } from './journal.ts';

export type SaveStatus =
  | { readonly kind: 'saved'; readonly at: number | null }
  | { readonly kind: 'saving' }
  /** The server can't be reached; the change is kept and retried. */
  | { readonly kind: 'offline' }
  /** Someone saved a newer revision (another tab): stop, and reload. */
  | { readonly kind: 'conflict' }
  /** The server refused the content: a bug, not something the annotator can fix. */
  | { readonly kind: 'rejected'; readonly problems: readonly string[] };

/** A change is sent once changes pause this long… */
const SAVE_DELAY_MS = 300;
/** …or at the latest this long after it was made, even while changes keep coming. */
const MAX_SAVE_DELAY_MS = 2000;
const MAX_RETRY_MS = 10_000;

export class Saver {
  readonly #recordingId: string;
  readonly #journal: UnsavedChanges | null;
  readonly #listeners = new Set<() => void>();
  #revision: number;
  #status: SaveStatus;
  /** The newest change not sent yet, and when it was written to the journal. */
  #pending: { readonly payload: SavePayload; readonly writtenAt: number } | null = null;
  /** When the oldest change not sent yet was made. */
  #pendingSince: number | null = null;
  #lastWrittenAt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | null = null;
  #retryMs = 1000;

  constructor(
    recordingId: string,
    revision: number,
    savedAt: number | null,
    journal: UnsavedChanges | null = null,
  ) {
    this.#recordingId = recordingId;
    this.#revision = revision;
    this.#status = { kind: 'saved', at: savedAt };
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
    return this.#pending !== null || this.#status.kind === 'saving';
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
   * Journals the newest version at once; it is sent once changes pause for a moment, and never
   * later than MAX_SAVE_DELAY_MS after the oldest change waiting.
   */
  save(payload: SavePayload): void {
    const now = Date.now();
    // Strictly increasing, so the journal can tell two quick changes apart.
    const writtenAt = Math.max(now, this.#lastWrittenAt + 1);
    this.#lastWrittenAt = writtenAt;
    this.#pending = { payload, writtenAt };
    this.#pendingSince ??= now;
    const entry = {
      recordingId: this.#recordingId,
      baseRevision: this.#revision,
      payload,
      writtenAt,
    };
    this.#journal?.write(entry).catch(() => {});
    // Not on the server yet: the chip must not say "saved" meanwhile.
    if (this.#status.kind === 'saved') this.#setStatus({ kind: 'saving' });
    clearTimeout(this.#timer);
    const latest = this.#pendingSince + MAX_SAVE_DELAY_MS - now;
    this.#timer = setTimeout(() => void this.flush(), Math.min(SAVE_DELAY_MS, latest));
  }

  /**
   * Sends anything pending now; resolves true once everything is saved. With `keepalive` the
   * request outlives the page, for when it is being hidden or closed.
   */
  async flush(keepalive = false): Promise<boolean> {
    clearTimeout(this.#timer);
    this.#running ??= this.#sendPending(keepalive).finally(() => {
      this.#running = null;
    });
    await this.#running;
    return this.#pending === null && this.#status.kind === 'saved';
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#listeners.clear();
  }

  async #sendPending(keepalive: boolean): Promise<void> {
    while (this.#pending && !this.stopped) {
      const sending = this.#pending;
      this.#pending = null;
      this.#pendingSince = null;
      this.#setStatus({ kind: 'saving' });
      try {
        this.#revision = (
          await saveAnnotation(this.#recordingId, this.#revision, sending.payload, keepalive)
        ).revision;
        this.#journal?.settle(this.#recordingId, sending.writtenAt, this.#revision).catch(() => {});
        this.#retryMs = 1000;
        this.#setStatus({ kind: 'saved', at: Date.now() });
      } catch (error) {
        if (error instanceof ApiError && error.status === 412)
          this.#setStatus({ kind: 'conflict' });
        else if (error instanceof ApiError && error.status === 400) {
          this.#setStatus({ kind: 'rejected', problems: error.body.problems ?? [error.message] });
        } else {
          this.#pending ??= sending;
          this.#pendingSince ??= Date.now();
          this.#setStatus({ kind: 'offline' });
          this.#timer = setTimeout(() => void this.flush(), this.#retryMs);
          this.#retryMs = Math.min(this.#retryMs * 2, MAX_RETRY_MS);
          return;
        }
      }
    }
  }

  #setStatus(status: SaveStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener();
  }
}
