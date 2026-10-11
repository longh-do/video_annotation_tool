/**
 * One recording's annotation for as long as the page is open: the editor with its undo history,
 * the saver, which journals every change and gets it to the server, and the effort and telemetry
 * that measure the work. It outlives the annotation screen, so coming back to a recording
 * (through the queue, or Undo on a toast) finds it exactly as it was, undo history included, and
 * a change made while the screen is closed is saved all the same.
 */
import type { Reference } from '../core/annotation.ts';
import type { SavePayload } from '../core/api-types.ts';
import { frameNs } from '../core/frame-map.ts';
import { parseNs } from '../core/ns.ts';
import { editEvents } from './edit-events.ts';
import { type EditorAction, type EditorState, editorReducer } from './editor.ts';
import { type Effort, EffortClock } from './effort.ts';
import type { Journal } from './journal.ts';
import { fromSaved, startingPoint, toSavePayload } from './persistence.ts';
import { DEFAULT_SPEED } from './player/player.ts';
import type { LoadedRecording } from './recording.ts';
import { Saver, type SaveStatus } from './saver.ts';
import { Store } from './store.ts';
import type { Telemetry } from './telemetry.ts';

/** Where the annotator is in the recording, saved so that it reopens there. */
export interface Place {
  readonly frame: number;
  /** The marking speed. */
  readonly playbackRate: number;
}

/** What the annotation screen tells the annotation while it is open. */
export interface Screen {
  readonly place: () => Place;
  readonly playing: () => boolean;
}

const HEARTBEAT_MS = 15_000;

/** Telemetry for each save status the saver moves into. */
const SAVE_EVENTS: Partial<Record<SaveStatus['kind'], string>> = {
  saved: 'save_acked',
  offline: 'save_failed',
  conflict: 'save_conflict',
  rejected: 'save_rejected',
};

export class AnnotationSession {
  readonly editor: Store<EditorState, EditorAction>;
  readonly saver: Saver;
  /** The journal held changes the server never got; they were reopened. */
  readonly recovered: boolean;
  /** The journal held changes that lost to a newer save (e.g. from another tab). */
  readonly discarded: boolean;
  readonly #reference: Reference;
  readonly #telemetry: Telemetry | null;
  readonly #stop: (() => void)[] = [];
  #place: Place;
  #screen: Screen | null = null;
  /** Effort so far; counted by the clock while the screen is open. */
  #effort: Effort;
  #clock: EffortClock | null = null;
  /** The fastest playback while annotating, for `task_submitted`. */
  #maxRate = 0;
  /** When the annotator landed on the rough mark being checked. */
  #visitStart: number | null = null;

  constructor(recording: LoadedRecording, journal: Journal | null, telemetry: Telemetry | null) {
    const { info } = recording;
    const frames = recording.frames[0]!;
    this.#reference = { recordingId: info.id, referenceVideo: info.cameras[0]!.video, frames };
    this.#telemetry = telemetry;
    const { start, recovered, discarded } = startingPoint(recording.saved, recording.unsaved);
    const restored = fromSaved(start, frames);
    this.recovered = recovered;
    this.discarded = discarded;
    this.editor = new Store(editorReducer, restored.editor);
    this.saver = new Saver(info.id, restored.revision, null, journal);
    this.#place = {
      frame: restored.resumeFrame,
      playbackRate: start?.sidecar?.resume.playback_rate ?? DEFAULT_SPEED,
    };
    this.#effort = { activeMs: restored.activeMs, wallMs: restored.wallMs };
    this.#stop.push(this.#saveChanges(), this.#logEdits(), this.#logSaves());
    if (recovered) {
      // Reopened changes aren't on the server yet.
      this.log('journal_recovered');
      this.saver.save(this.#payload());
    }
  }

  /** Where the annotator is: live while the screen is open, else where it was left. */
  get place(): Place {
    return this.#screen?.place() ?? this.#place;
  }

  /** The annotation screen opens on this recording; returns what to call when it closes. */
  attach(screen: Screen): () => void {
    this.#screen = screen;
    this.#clock = new EffortClock(this.#effort, screen.playing);
    const { outcome } = this.editor.getState();
    this.log('task_opened', { revision: this.saver.revision, status: outcome.status });
    const heartbeat = setInterval(
      () => this.log('activity_heartbeat', this.#effortFields()),
      HEARTBEAT_MS,
    );
    return () => {
      clearInterval(heartbeat);
      this.#place = screen.place();
      this.#effort = this.#clock?.read() ?? this.#effort;
      this.#clock = null;
      this.#screen = null;
    };
  }

  /** A key press or a pointer action on the screen: the annotator is at work. */
  noteInput(): void {
    this.#clock?.noteInput();
  }

  /** Playback started, stopped or changed speed (`rate` includes skimming and play-around). */
  notePlayback(playing: boolean, rate: number): void {
    if (playing) this.#maxRate = Math.max(this.#maxRate, rate);
    this.log('playback', { action: playing ? 'play' : 'pause', rate });
  }

  /** Logs an event about this recording, at the frame on screen. */
  log(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    const { frame, playbackRate } = this.place;
    const { recordingId, frames } = this.#reference;
    const mediaPosNs = String(frameNs(frames, Math.max(frame, 0)));
    this.#telemetry?.log({ recordingId, mediaPosNs, playbackRate }, event, fields);
  }

  /** Applies an outcome (submit, no useful task, needs review); true once it is saved. */
  async finish(action: EditorAction): Promise<boolean> {
    this.editor.dispatch(action);
    const saved = await this.saver.flush();
    if (saved) this.log('task_submitted', this.#submission());
    return saved;
  }

  dispose(): void {
    for (const stop of this.#stop) stop();
    this.saver.dispose();
  }

  /** Saves each change to the annotation (not to the selection), never in the middle of a drag. */
  #saveChanges(): () => void {
    let last = this.editor.getState();
    return this.editor.subscribe(() => {
      const current = this.editor.getState();
      if (current.history.gestureBase !== null) return;
      if (current.history.present === last.history.present && current.outcome === last.outcome) {
        return;
      }
      last = current;
      this.saver.save(this.#payload());
    });
  }

  /**
   * Logs each edit. An accepted rough mark carries the time since the annotator landed on it,
   * which the score report turns into seconds per checked boundary.
   */
  #logEdits(): () => void {
    return this.editor.observe((action, before, after) => {
      const now = performance.now();
      for (const { event, fields } of editEvents(action, before, after)) {
        const visit = this.#visitStart;
        const timed = event === 'boundary_accepted' && visit !== null;
        this.log(event, timed ? { ...fields, check_ms: Math.round(now - visit) } : fields);
      }
      if (after.selected !== before.selected) {
        const selected = after.history.present.boundaries.find((b) => b.frame === after.selected);
        this.#visitStart = selected && !selected.checked ? now : null;
      }
    });
  }

  #logSaves(): () => void {
    let last = this.saver.status.kind;
    return this.saver.subscribe(() => {
      const { kind } = this.saver.status;
      const event = SAVE_EVENTS[kind];
      if (kind !== last && event) this.log(event, { revision: this.saver.revision });
      last = kind;
    });
  }

  #effortFields() {
    const { activeMs, wallMs } = this.#clock?.read() ?? this.#effort;
    return { active_ms: Math.round(activeMs), wall_ms: Math.round(wallMs) };
  }

  #submission() {
    const { annotation, sidecar } = this.#payload();
    const keepNs = annotation.keep_intervals.reduce(
      (total, i) => total + parseNs(i.end_ns) - parseNs(i.start_ns),
      0n,
    );
    return {
      status: annotation.status,
      reason: sidecar.review_reason,
      n_intervals: annotation.keep_intervals.length,
      keep_ns_total: String(keepNs),
      ...this.#effortFields(),
      n_edits: sidecar.effort.edits,
      n_undos: sidecar.effort.undos,
      max_rate: this.#maxRate,
    };
  }

  #payload(): SavePayload {
    const { frame, playbackRate } = this.place;
    const { activeMs, wallMs } = this.#clock?.read() ?? this.#effort;
    return toSavePayload(this.editor.getState(), this.#reference, {
      resumeFrame: Math.max(frame, 0),
      playbackRate,
      activeMs,
      wallMs,
    });
  }
}
