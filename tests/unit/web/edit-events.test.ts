import { describe, expect, test } from 'vitest';
import { emptyTimeline } from '../../../src/core/timeline.ts';
import { editEvents } from '../../../src/web/edit-events.ts';
import {
  createEditor,
  type EditorAction,
  type EditorState,
  editorReducer,
} from '../../../src/web/editor.ts';

/** Runs the actions and collects the events each one yields. */
function events(actions: EditorAction[], start: EditorState = createEditor(emptyTimeline(200))) {
  const log: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  actions.reduce((state, action) => {
    const next = editorReducer(state, action);
    if (next !== state) log.push(...editEvents(action, state, next));
    return next;
  }, start);
  return log;
}

describe('edit events', () => {
  test('marks, flips, deletes, undo and redo are logged as they happen', () => {
    expect(
      events([
        { type: 'mark', frame: 10, state: 'keep', origin: 'live' },
        { type: 'flip', frame: 12 },
        { type: 'undo' },
        { type: 'redo' },
        { type: 'delete-selected' },
      ]).map((e) => e.event),
    ).toEqual(['boundary_set', 'segment_flipped', 'undo', 'redo', 'boundary_deleted']);
  });

  test('checking a rough mark is one acceptance, by Enter or by moving it', () => {
    const marked: EditorAction[] = [
      { type: 'mark', frame: 40, state: 'keep', origin: 'live' },
      { type: 'mark', frame: 90, state: 'cut', origin: 'live' },
    ];
    expect(events([...marked, { type: 'confirm', index: 0 }]).slice(2)).toEqual([
      { event: 'boundary_accepted', fields: { frame: 40, how: 'enter' } },
    ]);
    expect(events([...marked, { type: 'nudge', delta: -2, now: 0 }]).slice(2)).toEqual([
      { event: 'boundary_adjusted', fields: { how: 'nudge', from: 90, to: 88 } },
      { event: 'boundary_accepted', fields: { frame: 88, how: 'nudge' } },
    ]);
    // A second nudge moves an already checked boundary: no second acceptance.
    expect(
      events([
        ...marked,
        { type: 'nudge', delta: -1, now: 0 },
        { type: 'nudge', delta: -1, now: 900 },
      ])
        .slice(2)
        .map((e) => e.event),
    ).toEqual(['boundary_adjusted', 'boundary_accepted', 'boundary_adjusted']);
  });

  test('a drag is logged once, when it ends, with where it started', () => {
    const log = events([
      { type: 'mark', frame: 40, state: 'keep', origin: 'live' },
      { type: 'drag-start', index: 0 },
      { type: 'move', index: 0, frame: 45, origin: 'drag' },
      { type: 'move', index: 0, frame: 50, origin: 'drag' },
      { type: 'drag-end' },
    ]);
    expect(log.slice(1)).toEqual([
      { event: 'boundary_adjusted', fields: { how: 'drag', from: 40, to: 50 } },
      { event: 'boundary_accepted', fields: { frame: 50, how: 'drag' } },
    ]);
  });

  test('a thumbnail click is a filmstrip adjustment; selecting logs nothing', () => {
    const log = events([
      { type: 'mark', frame: 40, state: 'keep', origin: 'paused' },
      { type: 'select', frame: null },
      { type: 'select', frame: 40 },
      { type: 'move', index: 0, frame: 33, origin: 'placed' },
    ]);
    expect(log.map((e) => e.event)).toEqual(['boundary_set', 'boundary_adjusted']);
    expect(log[1]?.fields).toEqual({ how: 'filmstrip', from: 40, to: 33 });
  });
});
