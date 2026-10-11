/**
 * One recording's annotation for as long as the page is open: the editor with its undo history,
 * and the saver, which journals every change and gets it to the server. It outlives the
 * annotation screen, so coming back to a recording (through the queue, or Undo on a toast) finds
 * it exactly as it was, undo history included, and a change made while the screen is closed is
 * saved all the same.
 */
import type { Reference } from '../core/annotation.ts';
import type { SavePayload } from '../core/api-types.ts';
import { type EditorAction, type EditorState, editorReducer } from './editor.ts';
import type { Journal } from './journal.ts';
import { fromSaved, startingPoint, toSavePayload } from './persistence.ts';
import { DEFAULT_SPEED } from './player/player.ts';
import type { LoadedRecording } from './recording.ts';
import { Saver } from './saver.ts';
import { Store } from './store.ts';

/** Where the annotator is in the recording, saved so that it reopens there. */
export interface Place {
  readonly frame: number;
  readonly playbackRate: number;
}

export class AnnotationSession {
  readonly editor: Store<EditorState, EditorAction>;
  readonly saver: Saver;
  /** The journal held changes the server never got; they were reopened. */
  readonly recovered: boolean;
  /** The journal held changes that lost to a newer save (e.g. from another tab). */
  readonly discarded: boolean;
  readonly #reference: Reference;
  #place: Place;
  #where: (() => Place) | null = null;
  readonly #stopSaving: () => void;

  constructor(recording: LoadedRecording, journal: Journal | null) {
    const { info } = recording;
    const frames = recording.frames[0]!;
    this.#reference = { recordingId: info.id, referenceVideo: info.cameras[0]!.video, frames };
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
    this.#stopSaving = this.#saveChanges();
    // Reopened changes aren't on the server yet.
    if (recovered) this.saver.save(this.#payload());
  }

  /** Where the annotator is: live while the screen is open, else where it was left. */
  get place(): Place {
    return this.#where?.() ?? this.#place;
  }

  /** The annotation screen reports where the annotator is while it is open; returns detach. */
  attach(where: () => Place): () => void {
    this.#where = where;
    return () => {
      this.#place = where();
      this.#where = null;
    };
  }

  /** Applies an outcome (submit, no useful task, needs review); true once it is saved. */
  finish(action: EditorAction): Promise<boolean> {
    this.editor.dispatch(action);
    return this.saver.flush();
  }

  dispose(): void {
    this.#stopSaving();
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

  #payload(): SavePayload {
    const { frame, playbackRate } = this.place;
    return toSavePayload(this.editor.getState(), this.#reference, {
      resumeFrame: Math.max(frame, 0),
      playbackRate,
      activeMs: 0,
      wallMs: 0,
    });
  }
}
