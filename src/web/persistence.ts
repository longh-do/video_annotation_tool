/** How the editor maps to what the server saves, and back. */
import {
  keepIntervals,
  type Reference,
  sidecarBoundaries,
  timelineFromIntervals,
  timelineFromSidecar,
} from '../core/annotation.ts';
import type { SavedAnnotation, SavePayload } from '../core/api-types.ts';
import { type FrameMap, frameCount } from '../core/frame-map.ts';
import { emptyTimeline, type Timeline } from '../core/timeline.ts';
import { createEditor, type EditorState } from './editor.ts';

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

/**
 * Picks up where the last save left off: the sidecar restores every boundary exactly; a contract
 * file on its own (e.g. written by another tool) restores the kept intervals.
 */
export function fromSaved(saved: SavedAnnotation | null, frames: FrameMap): Restored {
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
