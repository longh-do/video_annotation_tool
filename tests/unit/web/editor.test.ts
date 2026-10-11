import { describe, expect, test } from 'vitest';
import { RUN_WINDOW_MS } from '../../../src/core/history.ts';
import { emptyTimeline, keepSegments } from '../../../src/core/timeline.ts';
import {
  createEditor,
  type EditorAction,
  type EditorState,
  editorReducer,
} from '../../../src/web/editor.ts';

const run = (actions: EditorAction[], start: EditorState = createEditor(emptyTimeline(100))) =>
  actions.reduce(editorReducer, start);
const frames = (state: EditorState) => state.history.present.boundaries.map((b) => b.frame);

describe('editor', () => {
  test('a mark selects its boundary; a repeated key changes nothing', () => {
    const state = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'paused' },
      { type: 'mark', frame: 12, state: 'keep', origin: 'paused' },
    ]);
    expect(frames(state)).toEqual([10]);
    expect(state.selected).toBe(10);
    expect(state.edits).toBe(1);
  });

  test('a held nudge key moves the selected boundary as one undo step, and stops at neighbours', () => {
    let state = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'live' },
      { type: 'mark', frame: 20, state: 'cut', origin: 'live' },
    ]);
    for (let i = 0; i < 15; i++)
      state = editorReducer(state, { type: 'nudge', delta: -1, now: i * 30 });
    expect(frames(state)).toEqual([10, 11]);
    expect(state.selected).toBe(11);
    expect(state.history.present.boundaries[1]).toMatchObject({ origin: 'nudge', checked: true });
    expect(frames(editorReducer(state, { type: 'undo' }))).toEqual([10, 20]);
    const later = editorReducer(state, {
      type: 'nudge',
      delta: 1,
      now: 15 * 30 + RUN_WINDOW_MS + 1,
    });
    expect(later.history.past).toHaveLength(state.history.past.length + 1);
  });

  test('nudging or deleting without a boundary or interval to act on changes nothing', () => {
    const start = createEditor(emptyTimeline(100));
    expect(editorReducer(start, { type: 'nudge', delta: 1, now: 0 })).toBe(start);
    expect(editorReducer(start, { type: 'delete-selected' })).toBe(start);
    expect(editorReducer(start, { type: 'delete-boundary', index: 0 })).toBe(start);
  });

  test('Backspace deletes the selected boundary, or else the selected interval', () => {
    const state = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'live' },
      { type: 'mark', frame: 40, state: 'cut', origin: 'live' },
    ]);
    const deleted = editorReducer(state, { type: 'delete-selected' });
    expect(frames(deleted)).toEqual([10]);
    expect(deleted.selected).toBeNull();
    const interval = run(
      [{ type: 'select-interval', start: 10 }, { type: 'delete-selected' }],
      state,
    );
    expect(frames(interval)).toEqual([]);
    expect(interval).toMatchObject({ selected: null, interval: null });
  });

  test('selecting an interval drops the boundary selection, and the other way round', () => {
    const marked = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'paused' },
      { type: 'mark', frame: 30, state: 'cut', origin: 'paused' },
    ]);
    const interval = editorReducer(marked, { type: 'select-interval', start: 10 });
    expect(interval).toMatchObject({ selected: null, anchor: null, interval: 10 });
    expect(editorReducer(interval, { type: 'select', frame: 30 })).toMatchObject({
      selected: 30,
      interval: null,
    });
  });

  test('a merge keeps the merged interval selected; a deleted interval leaves nothing selected', () => {
    const marked = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'paused' },
      { type: 'mark', frame: 30, state: 'cut', origin: 'paused' },
      { type: 'mark', frame: 50, state: 'keep', origin: 'paused' },
      { type: 'mark', frame: 70, state: 'cut', origin: 'paused' },
    ]);
    const merged = editorReducer(marked, { type: 'set-range', from: 30, to: 50, state: 'keep' });
    expect(frames(merged)).toEqual([10, 70]);
    expect(merged).toMatchObject({ selected: null, interval: 10 });
    const deleted = editorReducer(merged, { type: 'set-range', from: 10, to: 70, state: 'cut' });
    expect(frames(deleted)).toEqual([]);
    expect(deleted.interval).toBeNull();
    // Undo brings the interval back; the selection is view state, so it stays as it was.
    expect(frames(editorReducer(deleted, { type: 'undo' }))).toEqual([10, 70]);
  });

  test('trimming the selected interval keeps it selected, following its start', () => {
    const marked = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'paused' },
      { type: 'mark', frame: 30, state: 'cut', origin: 'paused' },
      { type: 'select-interval', start: 10 },
    ]);
    const trimmed = run(
      [
        { type: 'drag-start', index: 0 },
        { type: 'move', index: 0, frame: 14 },
        { type: 'drag-end' },
      ],
      marked,
    );
    expect(trimmed).toMatchObject({ selected: 14, interval: 14 });
    expect(editorReducer(trimmed, { type: 'undo' })).toMatchObject({ selected: 10, interval: 10 });
    // Grabbing a boundary of another interval drops the selection.
    const other = run(
      [
        { type: 'mark', frame: 50, state: 'keep', origin: 'paused' },
        { type: 'select-interval', start: 10 },
        { type: 'drag-start', index: 2 },
      ],
      marked,
    );
    expect(other).toMatchObject({ selected: 50, interval: null });
    // Escape during a drag of its start puts the interval back, still selected.
    const cancelled = run(
      [
        { type: 'drag-start', index: 0 },
        { type: 'move', index: 0, frame: 14 },
        { type: 'drag-cancel' },
      ],
      marked,
    );
    expect(cancelled).toMatchObject({ selected: 10, interval: 10 });
  });

  test('undoing a nudge keeps the moved boundary selected, where work on it began', () => {
    const nudged = run([
      { type: 'mark', frame: 50, state: 'keep', origin: 'live' },
      { type: 'nudge', delta: -1, now: 0 },
    ]);
    expect(nudged).toMatchObject({ selected: 49, anchor: 50 });
    const undone = editorReducer(nudged, { type: 'undo' });
    expect(undone).toMatchObject({ selected: 50, anchor: 50 });
    expect(editorReducer(undone, { type: 'redo' })).toMatchObject({ selected: 49, anchor: 50 });
  });

  test('undo keeps the selection only if its boundary still exists', () => {
    const marked = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'paused' },
      { type: 'mark', frame: 30, state: 'cut', origin: 'paused' },
    ]);
    const undone = editorReducer(marked, { type: 'undo' });
    expect(undone.selected).toBeNull();
    expect(undone.undos).toBe(1);
    const reselected = run([{ type: 'select', frame: 10 }, { type: 'undo' }], marked);
    expect(reselected.selected).toBe(10);
  });

  test('a drag is one edit and one undo step; dropping a checked boundary where it was is none', () => {
    const marked = run([{ type: 'mark', frame: 10, state: 'keep', origin: 'paused' }]);
    const dragged = run(
      [
        { type: 'drag-start', index: 0 },
        { type: 'move', index: 0, frame: 14 },
        { type: 'move', index: 0, frame: 18 },
        { type: 'drag-end' },
      ],
      marked,
    );
    expect(frames(dragged)).toEqual([18]);
    expect(dragged.edits).toBe(marked.edits + 1);
    expect(dragged.history.past).toHaveLength(marked.history.past.length + 1);
    const back = run(
      [
        { type: 'drag-start', index: 0 },
        { type: 'move', index: 0, frame: 14 },
        { type: 'move', index: 0, frame: 10 },
        { type: 'drag-end' },
      ],
      marked,
    );
    expect(back.history.past).toHaveLength(marked.history.past.length);
    expect(back.edits).toBe(marked.edits);
  });

  test('grabbing a handle selects it; Escape puts the boundary back and keeps it selected', () => {
    const marked = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'live' },
      { type: 'mark', frame: 30, state: 'cut', origin: 'live' },
    ]);
    const dragging = run(
      [
        { type: 'drag-start', index: 0 },
        { type: 'move', index: 0, frame: 16 },
      ],
      marked,
    );
    expect(dragging.selected).toBe(16);
    expect(dragging.anchor).toBe(10);
    const cancelled = editorReducer(dragging, { type: 'drag-cancel' });
    expect(cancelled.history.present).toBe(marked.history.present);
    expect(cancelled.selected).toBe(10);
    expect(cancelled.edits).toBe(marked.edits);
    expect(editorReducer(cancelled, { type: 'drag-cancel' })).toBe(cancelled);
    expect(editorReducer(cancelled, { type: 'drag-end' })).toBe(cancelled);
  });

  test('an outcome stands only for the timeline it was given for', () => {
    const submitted = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'paused' },
      { type: 'needs-review', reason: 'unclear_boundary', notes: 'Unclear boundary: hand hidden' },
    ]);
    expect(submitted.outcome).toEqual({
      status: 'needs_review',
      notes: 'Unclear boundary: hand hidden',
      reviewReason: 'unclear_boundary',
    });
    const edited = editorReducer(submitted, {
      type: 'mark',
      frame: 50,
      state: 'cut',
      origin: 'paused',
    });
    expect(edited.outcome).toEqual({
      status: 'not_reviewed',
      notes: 'Unclear boundary: hand hidden',
      reviewReason: null,
    });
    expect(editorReducer(edited, { type: 'submit' }).outcome.status).toBe('complete');
  });

  test('"no useful task" cuts everything and completes; undo makes it a draft again', () => {
    const marked = run([{ type: 'mark', frame: 10, state: 'keep', origin: 'paused' }]);
    const none = editorReducer(marked, { type: 'no-task' });
    expect(frames(none)).toEqual([]);
    expect(none.outcome.status).toBe('complete');
    const undone = editorReducer(none, { type: 'undo' });
    expect(frames(undone)).toEqual([10]);
    expect(undone.outcome.status).toBe('not_reviewed');
  });

  test('confirming a boundary in the check pass selects it', () => {
    const state = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'live' },
      { type: 'select', frame: null },
      { type: 'confirm', index: 0 },
    ]);
    expect(state.history.present.boundaries[0]?.checked).toBe(true);
    expect(state.selected).toBe(10);
  });

  test('the anchor stays where work on a boundary began while it moves, and resets on a new one', () => {
    let state = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'live' },
      { type: 'mark', frame: 50, state: 'cut', origin: 'live' },
    ]);
    expect(state).toMatchObject({ selected: 50, anchor: 50 });
    state = run(
      [
        { type: 'nudge', delta: -3, now: 0 },
        { type: 'move', index: 1, frame: 44 },
      ],
      state,
    );
    expect(state).toMatchObject({ selected: 44, anchor: 50 });
    state = editorReducer(state, { type: 'select', frame: 10 });
    expect(state).toMatchObject({ selected: 10, anchor: 10 });
    // Moving a boundary that wasn't selected anchors it where it was.
    state = editorReducer(state, { type: 'move', index: 1, frame: 40 });
    expect(state).toMatchObject({ selected: 40, anchor: 44 });
  });

  test('Backspace after trimming the selected interval deletes that interval, not its edge', () => {
    const marked = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'paused' },
      { type: 'mark', frame: 30, state: 'cut', origin: 'paused' },
      { type: 'mark', frame: 50, state: 'keep', origin: 'paused' },
      { type: 'mark', frame: 70, state: 'cut', origin: 'paused' },
      { type: 'select-interval', start: 10 },
    ]);
    const deleted = run(
      [
        { type: 'drag-start', index: 1 },
        { type: 'move', index: 1, frame: 25 },
        { type: 'drag-end' },
        { type: 'delete-selected' },
      ],
      marked,
    );
    expect(keepSegments(deleted.history.present)).toEqual([{ start: 50, end: 70, state: 'keep' }]);
    expect(deleted).toMatchObject({ selected: null, interval: null });
  });

  test('a held nudge key is one edit, as it is one undo step', () => {
    let state = run([{ type: 'mark', frame: 10, state: 'keep', origin: 'paused' }]);
    const edits = state.edits;
    for (let i = 0; i < 30; i++) {
      state = editorReducer(state, { type: 'nudge', delta: 1, now: i * 33 });
    }
    expect(frames(state)).toEqual([40]);
    expect(state.edits).toBe(edits + 1);
  });

  test('a move that cannot go anywhere changes nothing: it does not confirm a live mark', () => {
    const marked = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'live' },
      { type: 'mark', frame: 11, state: 'cut', origin: 'live' },
    ]);
    // The mark at 11 is selected, and 10 is in the way.
    expect(editorReducer(marked, { type: 'nudge', delta: -1, now: 0 })).toBe(marked);
    const dropped = run(
      [
        { type: 'drag-start', index: 0 },
        { type: 'move', index: 0, frame: 10 },
        { type: 'drag-end' },
      ],
      marked,
    );
    expect(dropped.history.present).toBe(marked.history.present);
    expect(dropped.history.present.boundaries.every((b) => !b.checked)).toBe(true);
  });

  test('a drag that is cancelled or ends where it began leaves a submitted annotation submitted', () => {
    const submitted = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'paused' },
      { type: 'submit' },
    ]);
    const cancelled = run(
      [
        { type: 'drag-start', index: 0 },
        { type: 'move', index: 0, frame: 14 },
        { type: 'drag-cancel' },
      ],
      submitted,
    );
    expect(cancelled.outcome).toBe(submitted.outcome);
    expect(cancelled.history.present).toBe(submitted.history.present);
    const back = run(
      [
        { type: 'drag-start', index: 0 },
        { type: 'move', index: 0, frame: 14 },
        { type: 'move', index: 0, frame: 10 },
        { type: 'drag-end' },
      ],
      submitted,
    );
    expect(back.outcome).toBe(submitted.outcome);
    // A drag that does move it makes the annotation a draft again.
    const moved = run(
      [
        { type: 'drag-start', index: 0 },
        { type: 'move', index: 0, frame: 14 },
        { type: 'drag-end' },
      ],
      submitted,
    );
    expect(moved.outcome.status).toBe('not_reviewed');
  });

  test('Submit clears a review note left from before', () => {
    const state = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'paused' },
      { type: 'needs-review', reason: 'unclear_boundary', notes: 'Unclear boundary: hand hidden' },
      { type: 'mark', frame: 50, state: 'cut', origin: 'paused' },
      { type: 'submit' },
    ]);
    expect(state.outcome).toEqual({ status: 'complete', notes: '', reviewReason: null });
  });
});
