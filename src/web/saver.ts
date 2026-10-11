/**
 * Saving: every change goes to the server shortly after it happens (debounced), one request at a
 * time, always the newest version. The status says exactly where things stand, for the save chip.
 */
import type { SavePayload } from '../core/api-types.ts';
import { ApiError, saveAnnotation } from './api.ts';

export type SaveStatus =
  | { readonly kind: 'saved'; readonly at: number | null }
  | { readonly kind: 'saving' }
  /** The server can't be reached; the change is kept and retried. */
  | { readonly kind: 'offline' }
  /** Someone saved a newer revision (another tab): stop, and reload. */
  | { readonly kind: 'conflict' }
  /** The server refused the content: a bug, not something the annotator can fix. */
  | { readonly kind: 'rejected'; readonly problems: readonly string[] };

const SAVE_DELAY_MS = 300;
const MAX_RETRY_MS = 10_000;

export class Saver {
  readonly #recordingId: string;
  readonly #listeners = new Set<() => void>();
  #revision: number;
  #status: SaveStatus;
  #pending: SavePayload | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | null = null;
  #retryMs = 1000;

  constructor(recordingId: string, revision: number, savedAt: number | null) {
    this.#recordingId = recordingId;
    this.#revision = revision;
    this.#status = { kind: 'saved', at: savedAt };
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

  /** Queues the newest version; it is sent once changes pause for a moment. */
  save(payload: SavePayload): void {
    this.#pending = payload;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
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
      const payload = this.#pending;
      this.#pending = null;
      this.#setStatus({ kind: 'saving' });
      try {
        this.#revision = (
          await saveAnnotation(this.#recordingId, this.#revision, payload, keepalive)
        ).revision;
        this.#retryMs = 1000;
        this.#setStatus({ kind: 'saved', at: Date.now() });
      } catch (error) {
        if (error instanceof ApiError && error.status === 412)
          this.#setStatus({ kind: 'conflict' });
        else if (error instanceof ApiError && error.status === 400) {
          this.#setStatus({ kind: 'rejected', problems: error.body.problems ?? [error.message] });
        } else {
          this.#pending ??= payload;
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
