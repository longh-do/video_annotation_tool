import { describe, expect, test } from 'vitest';
import {
  keepIntervals,
  timelineFromSidecar,
  validateAnnotationFile,
  validateSidecarDraft,
} from '../../../src/core/annotation.ts';
import type { SavedAnnotation, SavePayload } from '../../../src/core/api-types.ts';
import { emptyTimeline } from '../../../src/core/timeline.ts';
import { createEditor, type EditorAction, editorReducer } from '../../../src/web/editor.ts';
import { fromSaved, startingPoint, toSavePayload } from '../../../src/web/persistence.ts';
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

  test('changes left in the journal reopen if the server still has the revision they build on', () => {
    const saved = savedAt(5, toSavePayload(edited(), reference, session));
    const more = editorReducer(edited(), {
      type: 'mark',
      frame: 60,
      state: 'keep',
      origin: 'paused',
    });
    const payload = toSavePayload(more, reference, session);
    const entry = { recordingId: 'rec', baseRevision: 5, payload, inFlight: null, writtenAt: 1 };

    const recovered = startingPoint(saved, entry);
    expect(recovered).toMatchObject({ recovered: true, discarded: false });
    expect(fromSaved(recovered.start, frames).editor.history.present).toEqual(more.history.present);
    expect(fromSaved(recovered.start, frames).revision).toBe(5);

    // Nothing saved yet: the journal builds on revision 0.
    expect(startingPoint(null, { ...entry, baseRevision: 0 }).recovered).toBe(true);
  });

  test('if the server moved on, its version wins; the journal only counts as lost if different', () => {
    const payload = toSavePayload(edited(), reference, session);
    const entry = { recordingId: 'rec', baseRevision: 5, payload, inFlight: null, writtenAt: 1 };
    // The save landed but its answer was lost: same content, nothing lost.
    expect(startingPoint(savedAt(6, payload), entry)).toEqual({
      start: savedAt(6, payload),
      recovered: false,
      discarded: false,
    });
    // Another tab saved something else since.
    const other = toSavePayload(createEditor(emptyTimeline(100)), reference, session);
    expect(startingPoint(savedAt(6, other), entry)).toMatchObject({
      recovered: false,
      discarded: true,
    });
    expect(startingPoint(savedAt(6, other), null)).toMatchObject({ discarded: false });
  });

  test('changes made while a save was in flight reopen on top of that save, once it landed', () => {
    const first = toSavePayload(edited(), reference, session);
    const more = editorReducer(edited(), {
      type: 'mark',
      frame: 60,
      state: 'keep',
      origin: 'paused',
    });
    const second = toSavePayload(more, reference, session);
    const entry = {
      recordingId: 'rec',
      baseRevision: 5,
      payload: second,
      inFlight: first,
      writtenAt: 2,
    };
    // The first save landed as revision 6, but the page died before the second went out.
    const recovered = startingPoint(savedAt(6, first), entry);
    expect(recovered).toMatchObject({ recovered: true, discarded: false });
    expect(recovered.start?.revision).toBe(6);
    expect(fromSaved(recovered.start, frames).editor.history.present).toEqual(more.history.present);
    // Revision 6 holds something else (another tab): the server wins.
    const other = toSavePayload(createEditor(emptyTimeline(100)), reference, session);
    expect(startingPoint(savedAt(6, other), entry)).toMatchObject({
      recovered: false,
      discarded: true,
    });
  });
});

function savedAt(revision: number, { annotation, sidecar }: SavePayload): SavedAnnotation {
  return {
    revision,
    annotation,
    sidecar: {
      ...sidecar,
      revision,
      saved_at: '2030-01-01T00:00:00.000Z',
      annotator_id: 'a1',
      guideline_version: null,
      tool_version: '0.1.0',
    },
  };
}
