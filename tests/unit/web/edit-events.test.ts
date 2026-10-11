import { describe, expect, test } from 'vitest';
import { emptyTimeline } from '../../../src/core/timeline.ts';
import { editEvent } from '../../../src/web/edit-events.ts';
import {
  createEditor,
  type EditorAction,
  type EditorState,
  editorReducer,
} from '../../../src/web/editor.ts';

/** Runs the actions and collects the events they yield. */
function events(actions: EditorAction[], start: EditorState = createEditor(emptyTimeline(200))) {
  const log: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  actions.reduce((state, action) => {
    const next = editorReducer(state, action);
    const event = next === state ? null : editEvent(action, state, next);
    if (event) log.push(event);
    return next;
  }, start);
  return log;
}

describe('edit events', () => {
  test('marks, ranges, deletes, undo and redo are logged as they happen', () => {
    expect(
      events([
        { type: 'mark', frame: 10, state: 'keep', origin: 'live' },
        { type: 'set-range', from: 12, to: 20, state: 'cut' },
        { type: 'undo' },
        { type: 'redo' },
        { type: 'select', frame: 10 },
        { type: 'delete-selected' },
      ]).map((e) => e.event),
    ).toEqual(['boundary_set', 'range_set', 'undo', 'redo', 'boundary_deleted']);
  });

  test('deleting by badge or a selected interval says what went', () => {
    const log = events([
      { type: 'mark', frame: 10, state: 'keep', origin: 'paused' },
      { type: 'mark', frame: 30, state: 'cut', origin: 'paused' },
      { type: 'delete-boundary', index: 1 },
      { type: 'mark', frame: 30, state: 'cut', origin: 'paused' },
      { type: 'select-interval', start: 10 },
      { type: 'delete-selected' },
    ]);
    expect(log.slice(2).map((e) => [e.event, e.fields])).toEqual([
      ['boundary_deleted', { frame: 30 }],
      ['boundary_set', { frame: 30, state: 'cut', origin: 'paused' }],
      ['range_set', { from: 10, to: 30, state: 'cut' }],
    ]);
  });

  test('a nudge is logged as an adjustment, with where the boundary went', () => {
    expect(
      events([
        { type: 'mark', frame: 50, state: 'keep', origin: 'live' },
        { type: 'mark', frame: 100, state: 'cut', origin: 'live' },
        { type: 'select', frame: 50 },
        { type: 'nudge', delta: -2, now: 0 },
        { type: 'confirm', index: 0 },
      ]).map((e) => [e.event, e.fields]),
    ).toEqual([
      ['boundary_set', { frame: 50, state: 'keep', origin: 'live' }],
      ['boundary_set', { frame: 100, state: 'cut', origin: 'live' }],
      ['boundary_adjusted', { how: 'nudge', from: 50, to: 48 }],
    ]);
  });

  test('Backspace on a selected interval logs the interval, even with its edge selected too', () => {
    const log = events([
      { type: 'mark', frame: 10, state: 'keep', origin: 'paused' },
      { type: 'mark', frame: 30, state: 'cut', origin: 'paused' },
      { type: 'select-interval', start: 10 },
      { type: 'drag-start', index: 1 },
      { type: 'drag-cancel' },
      { type: 'delete-selected' },
    ]);
    expect(log.at(-1)).toEqual({ event: 'range_set', fields: { from: 10, to: 30, state: 'cut' } });
  });

  test('a drag is logged once, when it ends, with where it started', () => {
    const log = events([
      { type: 'mark', frame: 40, state: 'keep', origin: 'live' },
      { type: 'drag-start', index: 0 },
      { type: 'move', index: 0, frame: 45 },
      { type: 'move', index: 0, frame: 50 },
      { type: 'drag-end' },
    ]);
    expect(log.slice(1)).toEqual([
      { event: 'boundary_adjusted', fields: { how: 'drag', from: 40, to: 50 } },
    ]);
  });

  test('selecting logs nothing', () => {
    const log = events([
      { type: 'mark', frame: 40, state: 'keep', origin: 'paused' },
      { type: 'select', frame: null },
      { type: 'select', frame: 40 },
    ]);
    expect(log.map((e) => e.event)).toEqual(['boundary_set']);
  });
});
