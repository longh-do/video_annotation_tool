import { describe, expect, test } from 'vitest';
import {
  keepIntervals,
  timelineFromSidecar,
  validateAnnotationFile,
  validateSidecarDraft,
} from '../../../src/core/annotation.ts';
import type { SavedAnnotation } from '../../../src/core/api-types.ts';
import { emptyTimeline } from '../../../src/core/timeline.ts';
import { createEditor, type EditorAction, editorReducer } from '../../../src/web/editor.ts';
import { fromSaved, toSavePayload } from '../../../src/web/persistence.ts';
import { frameMap } from '../synthetic.ts';

const frames = frameMap(3_000_000_000_000n, new Array(99).fill(33_000));
const reference = { recordingId: 'rec', referenceVideo: 'videos/head-0000.mp4', frames };
const session = { resumeFrame: 42, playbackRate: 2, activeMs: 1234.4, wallMs: 2000 };

function edited() {
  const actions: EditorAction[] = [
    { type: 'mark', frame: 10, state: 'keep', origin: 'live' },
    { type: 'mark', frame: 30, state: 'cut', origin: 'paused' },
    { type: 'needs-review', reason: 'unfinished_task', notes: 'Unfinished task' },
  ];
  return actions.reduce(editorReducer, createEditor(emptyTimeline(100)));
}

describe('saving', () => {
  test('what the editor sends passes the server checks', () => {
    const { annotation, sidecar } = toSavePayload(edited(), reference, session);
    expect(validateAnnotationFile(annotation, reference)).toEqual([]);
    expect(validateSidecarDraft(sidecar, frames)).toEqual([]);
    expect(keepIntervals(timelineFromSidecar(sidecar.boundaries, frames), frames)).toEqual(
      annotation.keep_intervals,
    );
    expect(sidecar).toMatchObject({
      review_reason: 'unfinished_task',
      resume: { frame: 42, playback_rate: 2 },
      effort: { active_ms: 1234, wall_ms: 2000, edits: 2, undos: 0 },
    });
  });

  test('reopening restores every boundary, the outcome, the counters and the revision', () => {
    const { annotation, sidecar: draft } = toSavePayload(edited(), reference, session);
    const saved: SavedAnnotation = {
      revision: 7,
      annotation,
      sidecar: {
        ...draft,
        revision: 7,
        saved_at: '2030-01-01T00:00:00.000Z',
        annotator_id: 'a1',
        guideline_version: null,
        tool_version: '0.1.0',
      },
    };
    const restored = fromSaved(saved, frames);
    expect(restored.editor.history.present).toEqual(edited().history.present);
    expect(restored.editor.outcome).toEqual(edited().outcome);
    expect(restored).toMatchObject({ revision: 7, resumeFrame: 42, activeMs: 1234, wallMs: 2000 });
    expect(restored.editor).toMatchObject({ edits: 2, undos: 0 });
  });

  test('a contract file without a sidecar restores its intervals; nothing saved starts empty', () => {
    const { annotation } = toSavePayload(edited(), reference, session);
    const restored = fromSaved({ revision: 3, annotation, sidecar: null }, frames);
    expect(keepIntervals(restored.editor.history.present, frames)).toEqual(
      annotation.keep_intervals,
    );
    expect(restored.revision).toBe(3);
    expect(fromSaved(null, frames)).toMatchObject({ revision: 0, resumeFrame: 0 });
  });
});
