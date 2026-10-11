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
import { editEvent } from './edit-events.ts';
import { type EditorAction, type EditorState, editorReducer } from './editor.ts';
import { type Effort, EffortClock } from './effort.ts';
import type { UnsavedChanges } from './journal.ts';
import { fromSaved, startingPoint, toSavePayload } from './persistence.ts';
import { DEFAULT_SPEED } from './player/player.ts';
import type { LoadedRecording } from './recording.ts';
import { Saver, type SaveStatus } from './saver.ts';
import { Store } from './store.ts';
import type { Telemetry } from './telemetry.ts';

/** Where the annotator is in the recording, saved so that it reopens there. */
export interface Place {
  /** The frame on screen; -1 before the first one is shown. */
  readonly frame: number;
  /** The marking speed. */
  readonly playbackRate: number;
}

const HEARTBEAT_MS = 15_000;

/** Telemetry for each save status the saver moves into. */
const SAVE_EVENTS: Partial<Record<SaveStatus['kind'], string>> = {
  saved: 'save_acked',
  offline: 'save_failed',
  conflict: 'save_conflict',
  rejected: 'save_rejected',
};

/** How an action checked a rough mark, for `boundary_accepted`. */
function howChecked(action: EditorAction): string {
  switch (action.type) {
    case 'confirm':
      return 'enter';
    case 'move':
      return action.origin === 'drag' ? 'drag' : 'filmstrip';
    case 'move-nearest':
      return 'move_here';
    default:
      return action.type;
  }
}

/** A visit to a rough mark in the check pass, from landing on it to accepting or leaving it. */
interface Visit {
  /** Where the mark was when the visit began (the editor's anchor). */
  readonly anchor: number;
  readonly startedAt: number;
  /** How it got checked, once it is. */
  how: string | null;
}

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
  #where: (() => Place) | null = null;
  /** Effort so far; counted by the clock while the screen is open. */
  #effort: Effort;
  #clock: EffortClock | null = null;
  /** The fastest playback while annotating, for `task_submitted`. */
  #maxRate = 0;
  #visit: Visit | null = null;
  /** What was last handed to the saver: `task_submitted` reports the same numbers. */
  #lastPayload: SavePayload | null = null;

  constructor(
    recording: LoadedRecording,
    journal: UnsavedChanges | null,
    telemetry: Telemetry | null,
  ) {
    const { info, unsaved } = recording;
    const frames = recording.frames[0]!;
    this.#reference = { recordingId: info.id, referenceVideo: info.cameras[0]!.video, frames };
    this.#telemetry = telemetry;
    const { start, recovered, discarded } = startingPoint(recording.saved, unsaved);
    const restored = fromSaved(start, frames);
    this.recovered = recovered;
    this.discarded = discarded;
    this.editor = new Store(editorReducer, restored.editor);
    this.saver = new Saver(info.id, restored.revision, journal);
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
    } else if (unsaved) {
      // They lost to the server's version: keeping them would only bring them up again.
      journal?.forget(info.id, unsaved.writtenAt).catch(() => {});
    }
  }

  /** Where the annotator is: live while the screen is open, else where it was left. */
  get place(): Place {
    return this.#where?.() ?? this.#place;
  }

  /** The annotation screen opens on this recording; returns what to call when it closes. */
  attach(where: () => Place): () => void {
    this.#where = where;
    const clock = new EffortClock(this.#effort, document.visibilityState === 'visible');
    this.#clock = clock;
    const onVisibility = () => clock.setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    const { outcome } = this.editor.getState();
    this.log('task_opened', { revision: this.saver.revision, status: outcome.status });
    const heartbeat = setInterval(
      () => this.log('activity_heartbeat', this.#effortFields(clock.read())),
      HEARTBEAT_MS,
    );
    return () => {
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisibility);
      this.#endVisit();
      this.#place = where();
      this.#effort = clock.read();
      this.#clock = null;
      this.#where = null;
    };
  }

  /** A key press or a pointer action on the screen: the annotator is at work. */
  noteInput(): void {
    this.#clock?.noteInput();
  }

  /** Playback started, stopped or changed speed (`rate` includes skimming and play-around). */
  notePlayback(playing: boolean, rate: number, action: 'play' | 'pause' | 'rate'): void {
    this.#clock?.setPlaying(playing);
    if (playing) this.#maxRate = Math.max(this.#maxRate, rate);
    this.log('playback', { action, rate });
  }

  /** Logs an event about this recording, at the frame on screen. */
  log(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    const { frame, playbackRate } = this.place;
    const { recordingId, frames } = this.#reference;
    const mediaPosNs = frame < 0 ? null : String(frameNs(frames, frame));
    this.#telemetry?.log({ recordingId, mediaPosNs, playbackRate }, event, fields);
  }

  /** Applies an outcome (submit, no useful task, needs review); true once it is saved. */
  async finish(action: EditorAction): Promise<boolean> {
    this.#endVisit();
    this.editor.dispatch(action);
    const saved = await this.saver.flush();
    if (saved && this.#lastPayload) this.log('task_submitted', this.#submission(this.#lastPayload));
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
      this.#lastPayload = this.#payload();
      this.saver.save(this.#lastPayload);
    });
  }

  #logEdits(): () => void {
    return this.editor.observe((action, before, after) => {
      const event = after === before ? null : editEvent(action, before, after);
      if (event) this.log(event.event, event.fields);
      // Every action, even Enter on a mark already checked: it ends the visit.
      this.#trackVisit(action, after);
    });
  }

  /**
   * Times the check pass per boundary. A visit starts when the annotator lands on a rough mark
   * (Enter, [ ] or a click), not when a mark is made, and ends at Enter on it or on leaving it.
   * If the mark got checked meanwhile, by whatever means, `boundary_accepted` carries the time.
   */
  #trackVisit(action: EditorAction, after: EditorState): void {
    const visit = this.#visit;
    if (visit && after.anchor === visit.anchor) {
      const boundary = after.history.present.boundaries.find((b) => b.frame === after.selected);
      if (boundary?.checked) visit.how ??= howChecked(action);
      if (action.type === 'confirm') this.#endVisit();
      return;
    }
    this.#endVisit();
    const landed = action.type === 'select' || action.type === 'drag-start';
    const boundary = after.history.present.boundaries.find((b) => b.frame === after.selected);
    if (landed && boundary && !boundary.checked && after.anchor !== null) {
      this.#visit = { anchor: after.anchor, startedAt: performance.now(), how: null };
    }
  }

  #endVisit(): void {
    const visit = this.#visit;
    this.#visit = null;
    if (!visit?.how) return;
    const checkMs = Math.round(performance.now() - visit.startedAt);
    this.log('boundary_accepted', { frame: visit.anchor, how: visit.how, check_ms: checkMs });
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

  #effortFields({ activeMs, wallMs }: Effort) {
    return { active_ms: Math.round(activeMs), wall_ms: Math.round(wallMs) };
  }

  #submission({ annotation, sidecar }: SavePayload) {
    const keepNs = annotation.keep_intervals.reduce(
      (total, i) => total + parseNs(i.end_ns) - parseNs(i.start_ns),
      0n,
    );
    return {
      status: annotation.status,
      reason: sidecar.review_reason,
      n_intervals: annotation.keep_intervals.length,
      keep_ns_total: String(keepNs),
      active_ms: sidecar.effort.active_ms,
      wall_ms: sidecar.effort.wall_ms,
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
