/** How the editor maps to what the server saves, and back. */
import {
  keepIntervals,
  type Reference,
  type SidecarDraft,
  sidecarBoundaries,
  timelineFromIntervals,
  timelineFromSidecar,
} from '../core/annotation.ts';
import type { SavedAnnotation, SavePayload } from '../core/api-types.ts';
import { type FrameMap, frameCount } from '../core/frame-map.ts';
import { emptyTimeline, type Timeline } from '../core/timeline.ts';
import { createEditor, type EditorState } from './editor.ts';
import type { JournalEntry } from './journal.ts';

export interface SessionState {
  /** Where to reopen the recording. */
  readonly resumeFrame: number;
  readonly playbackRate: number;
  readonly activeMs: number;
  readonly wallMs: number;
}

export function toSavePayload(
  editor: EditorState,
  reference: Reference,
  session: SessionState,
): SavePayload {
  const timeline = editor.history.present;
  const { status, notes, reviewReason } = editor.outcome;
  return {
    annotation: {
      recording_id: reference.recordingId,
      reference_video: reference.referenceVideo,
      status,
      keep_intervals: keepIntervals(timeline, reference.frames),
      notes,
    },
    sidecar: {
      schema_version: 1,
      frame_count: frameCount(reference.frames),
      boundaries: sidecarBoundaries(timeline, reference.frames),
      review_reason: reviewReason,
      resume: { frame: session.resumeFrame, playback_rate: session.playbackRate },
      effort: {
        active_ms: Math.round(session.activeMs),
        wall_ms: Math.round(session.wallMs),
        edits: editor.edits,
        undos: editor.undos,
      },
    },
  };
}

export interface Restored {
  readonly editor: EditorState;
  readonly revision: number;
  readonly resumeFrame: number;
  readonly activeMs: number;
  readonly wallMs: number;
}

/** What can be reopened: a saved annotation, or changes that never reached the server. */
export interface Reopenable {
  readonly revision: number;
  readonly annotation: SavedAnnotation['annotation'];
  readonly sidecar: SidecarDraft | null;
}

/**
 * Picks up where the last save left off: the sidecar restores every boundary exactly; a contract
 * file on its own (e.g. written by another tool) restores the kept intervals.
 */
export function fromSaved(saved: Reopenable | null, frames: FrameMap): Restored {
  const sidecar = saved?.sidecar ?? null;
  let timeline: Timeline = emptyTimeline(frameCount(frames));
  if (sidecar) timeline = timelineFromSidecar(sidecar.boundaries, frames);
  else if (saved) timeline = timelineFromIntervals(saved.annotation.keep_intervals, frames);
  const outcome = saved && {
    status: saved.annotation.status,
    notes: saved.annotation.notes,
    reviewReason: sidecar?.review_reason ?? null,
  };
  const counts = { edits: sidecar?.effort.edits ?? 0, undos: sidecar?.effort.undos ?? 0 };
  return {
    editor: createEditor(timeline, outcome ?? undefined, counts),
    revision: saved?.revision ?? 0,
    resumeFrame: sidecar?.resume.frame ?? 0,
    activeMs: sidecar?.effort.active_ms ?? 0,
    wallMs: sidecar?.effort.wall_ms ?? 0,
  };
}

export interface StartingPoint {
  readonly start: Reopenable | null;
  /** The journal held changes the server never got: they are reopened and must be saved. */
  readonly recovered: boolean;
  /** The journal held changes that lost to a newer save (e.g. from another tab). */
  readonly discarded: boolean;
}

/**
 * Where to reopen a recording. Changes left in the journal are reopened if they build on what the
 * server has: the revision they were made on, or the one after it when that is the save that was
 * in flight (it landed, but the page died before hearing so). Otherwise the server's version wins:
 * the journal's content landed too, or another tab saved since. `revision` is the server's, which
 * outlives deleted annotation files.
 */
export function startingPoint(
  saved: SavedAnnotation | null,
  unsaved: JournalEntry | null,
  revision = saved?.revision ?? 0,
): StartingPoint {
  const builtOn =
    unsaved?.baseRevision === revision ||
    (unsaved?.baseRevision === revision - 1 && sameContent(saved, unsaved.inFlight));
  if (unsaved && builtOn) {
    return { start: { revision, ...unsaved.payload }, recovered: true, discarded: false };
  }
  const discarded = unsaved !== null && !sameContent(saved, unsaved.payload);
  return { start: saved, recovered: false, discarded };
}

/** Whether the server has this content: the same annotation and boundaries, effort aside. */
export function sameContent(saved: SavedAnnotation | null, payload: SavePayload | null): boolean {
  if (!saved?.sidecar || !payload) return false;
  const { status, notes, keep_intervals } = saved.annotation;
  const essence = (boundaries: SidecarDraft['boundaries']) =>
    JSON.stringify(boundaries.map((b) => [b.frame, b.state, b.origin, b.checked]));
  return (
    status === payload.annotation.status &&
    notes === payload.annotation.notes &&
    JSON.stringify(keep_intervals) === JSON.stringify(payload.annotation.keep_intervals) &&
    saved.sidecar.review_reason === payload.sidecar.review_reason &&
    essence(saved.sidecar.boundaries) === essence(payload.sidecar.boundaries)
  );
}
