/**
 * The annotations of this page, one per recording, kept for the page's lifetime (see
 * AnnotationSession), and the one place that decides whether a kept one is still current.
 */
import { AnnotationSession } from './annotation-session.ts';
import type { Journal } from './journal.ts';
import { type LoadedRecording, loadRecording } from './recording.ts';
import type { Telemetry } from './telemetry.ts';

export interface Opened {
  readonly recording: LoadedRecording;
  readonly annotation: AnnotationSession;
  /** The annotation was (re)made from the server and the journal, not kept from earlier. */
  readonly fresh: boolean;
}

export class Sessions {
  readonly #journal: Journal | null;
  readonly #telemetry: Telemetry | null;
  readonly #kept = new Map<string, AnnotationSession>();
  /** Opens in progress: opening a recording twice at once loads it once. */
  readonly #loading = new Map<string, Promise<Opened>>();

  constructor(journal: Journal | null, telemetry: Telemetry | null) {
    this.#journal = journal;
    this.#telemetry = telemetry;
  }

  /**
   * A recording and its annotation: the one kept from earlier in this page if the server still
   * has its revision (undo history and all), else a new one from the server and the journal.
   */
  open(id: string): Promise<Opened> {
    let pending = this.#loading.get(id);
    if (!pending) {
      pending = this.#load(id).finally(() => this.#loading.delete(id));
      this.#loading.set(id, pending);
    }
    return pending;
  }

  get(id: string): AnnotationSession | undefined {
    return this.#kept.get(id);
  }

  /** Something isn't on the server yet. */
  get dirty(): boolean {
    return [...this.#kept.values()].some((annotation) => annotation.saver.dirty);
  }

  /** Sends whatever isn't saved yet; `keepalive` when the page is going away. */
  flushAll(keepalive: boolean): void {
    for (const annotation of this.#kept.values()) void annotation.saver.flush(keepalive);
  }

  async #load(id: string): Promise<Opened> {
    // What is pending reaches the server first, so the revisions compared below are current.
    const kept = this.#kept.get(id);
    await kept?.saver.flush();
    const recording = await loadRecording(id, this.#journal);
    if (kept && kept.saver.revision === (recording.saved?.revision ?? 0)) {
      return { recording, annotation: kept, fresh: false };
    }
    kept?.dispose();
    const annotation = new AnnotationSession(recording, this.#journal, this.#telemetry);
    this.#kept.set(id, annotation);
    return { recording, annotation, fresh: true };
  }
}
