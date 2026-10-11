import { describe, expect, test } from 'vitest';
import { RUN_WINDOW_MS } from '../../../src/core/history.ts';
import { emptyTimeline } from '../../../src/core/timeline.ts';
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

  test('nudging, deleting or T without a boundary to act on changes nothing', () => {
    const start = createEditor(emptyTimeline(100));
    expect(editorReducer(start, { type: 'nudge', delta: 1, now: 0 })).toBe(start);
    expect(editorReducer(start, { type: 'delete-selected' })).toBe(start);
    expect(editorReducer(start, { type: 'move-nearest', frame: 5, origin: 'placed' })).toBe(start);
  });

  test('T moves the nearest boundary to the playhead; Backspace deletes the selected one', () => {
    const state = run([
      { type: 'mark', frame: 10, state: 'keep', origin: 'live' },
      { type: 'mark', frame: 40, state: 'cut', origin: 'live' },
      { type: 'move-nearest', frame: 35, origin: 'placed' },
    ]);
    expect(frames(state)).toEqual([10, 35]);
    expect(state.selected).toBe(35);
    const deleted = editorReducer(state, { type: 'delete-selected' });
    expect(frames(deleted)).toEqual([10]);
    expect(deleted.selected).toBeNull();
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
        { type: 'move', index: 0, frame: 14, origin: 'drag' },
        { type: 'move', index: 0, frame: 18, origin: 'drag' },
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
        { type: 'move', index: 0, frame: 14, origin: 'drag' },
        { type: 'move', index: 0, frame: 10, origin: 'drag' },
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
        { type: 'move', index: 0, frame: 16, origin: 'drag' },
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
        { type: 'move', index: 1, frame: 44, origin: 'placed' },
      ],
      state,
    );
    expect(state).toMatchObject({ selected: 44, anchor: 50 });
    state = editorReducer(state, { type: 'select', frame: 10 });
    expect(state).toMatchObject({ selected: 10, anchor: 10 });
    // Moving a boundary that wasn't selected anchors it where it was.
    state = editorReducer(state, { type: 'move', index: 1, frame: 40, origin: 'drag' });
    expect(state).toMatchObject({ selected: 40, anchor: 44 });
  });
});
