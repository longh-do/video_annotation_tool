/**
 * The annotations of this page, one per recording, and the one place that decides whether a kept
 * one is still current. The recording opened last and the one before it are kept (see
 * AnnotationSession; Back and Undo on a toast return there), any with changes not saved yet, and
 * any held (the one on screen, or the one a message's Undo acts on); the others are dropped, and
 * reopen from the server without their undo history.
 *
 * One tab of the browser edits a recording at a time: the one holding its Web Lock, which alone
 * uses its journal entry. Another tab opens it read-only, so two tabs never journal, recover or
 * save over each other's changes.
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

/** How many of the recordings opened last keep their annotation. */
const KEPT = 2;

export class Sessions {
  readonly #journal: Journal | null;
  readonly #telemetry: Telemetry | null;
  readonly #kept = new Map<string, AnnotationSession>();
  /** The recordings whose lock this tab holds, and how to let go of each. */
  readonly #claimed = new Map<string, () => void>();
  /** Opens in progress: opening a recording twice at once loads it once. */
  readonly #loading = new Map<string, Promise<Opened>>();
  /** The recordings opened last, the latest last. */
  #recent: string[] = [];
  /** How many holds each held recording has. */
  readonly #held = new Map<string, number>();

  constructor(journal: Journal | null, telemetry: Telemetry | null) {
    // Without Web Locks (a page served neither from localhost nor over HTTPS) a tab can't tell
    // whether another one has a recording open: then no tab uses the journal.
    this.#journal = 'locks' in navigator ? journal : null;
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

  /**
   * Keeps a recording's annotation, and its lock, while something still acts on it: the screen
   * that shows it, or a message's Undo. Returns the release.
   */
  hold(id: string): () => void {
    this.#held.set(id, (this.#held.get(id) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const left = (this.#held.get(id) ?? 1) - 1;
      if (left > 0) this.#held.set(id, left);
      else this.#held.delete(id);
    };
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
    const editable = await this.#claim(id);
    const journal = editable ? this.#journal : null;
    let recording: LoadedRecording;
    try {
      recording = await loadRecording(id, journal);
    } catch (error) {
      // Not opened here, so another tab may edit it.
      if (!this.#kept.has(id)) this.#letGo(id);
      throw error;
    }
    let opened: Opened;
    if (kept && !kept.openElsewhere && kept.saver.revision === recording.revision) {
      opened = { recording, annotation: kept, fresh: false };
    } else {
      kept?.dispose();
      const annotation = new AnnotationSession(recording, journal, this.#telemetry, !editable);
      this.#kept.set(id, annotation);
      opened = { recording, annotation, fresh: true };
    }
    this.#keepRecent(id);
    return opened;
  }

  /** Whether this tab may edit the recording: no other tab holds its lock. */
  async #claim(id: string): Promise<boolean> {
    if (this.#claimed.has(id)) return true;
    const release = await claim(id);
    if (release) this.#claimed.set(id, release);
    return release !== null;
  }

  /** Drops the annotations that are neither recent nor unsaved, and lets go of their locks. */
  #keepRecent(id: string): void {
    this.#recent = [...this.#recent.filter((other) => other !== id), id].slice(-KEPT);
    for (const [other, annotation] of this.#kept) {
      if (this.#recent.includes(other) || this.#held.has(other) || annotation.saver.dirty) continue;
      annotation.dispose();
      this.#kept.delete(other);
    }
    for (const other of this.#claimed.keys()) {
      if (!this.#kept.has(other) && !this.#loading.has(other)) this.#letGo(other);
    }
  }

  #letGo(id: string): void {
    this.#claimed.get(id)?.();
    this.#claimed.delete(id);
  }
}

/**
 * Takes the recording's Web Lock, held until `release` is called or the tab goes away. Null if
 * another tab holds it. Without Web Locks every tab may edit (and none uses the journal).
 */
function claim(id: string): Promise<(() => void) | null> {
  if (!('locks' in navigator)) return Promise.resolve(() => {});
  return new Promise((resolve) => {
    navigator.locks
      .request(`annotation:${id}`, { ifAvailable: true }, (lock) =>
        lock ? new Promise<void>((release) => resolve(release)) : resolve(null),
      )
      .catch(() => resolve(null));
  });
}
