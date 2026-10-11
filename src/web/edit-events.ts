/**
 * Telemetry for edits, derived from the editor's actions in one place rather than logged from
 * every key and click. Event names follow the plan's event list (G2).
 */
import type { Timeline } from '../core/timeline.ts';
import { type EditorAction, type EditorState, selectedInterval } from './editor.ts';

export interface EditEvent {
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * The event for an action that changed the editor, if it is worth one. Accepting a rough mark is
 * logged by the annotation session, which times each visit to a boundary in the check pass.
 */
export function editEvent(
  action: EditorAction,
  before: EditorState,
  after: EditorState,
): EditEvent | null {
  const was = before.history.present;
  const now = after.history.present;
  switch (action.type) {
    case 'mark':
      return {
        event: 'boundary_set',
        fields: { frame: action.frame, state: action.state, origin: action.origin },
      };
    case 'move':
      // A drag's every step is not worth an event; its end is.
      return action.origin === 'drag' ? null : adjusted('filmstrip', was, now);
    case 'nudge':
      return adjusted('nudge', was, now);
    case 'drag-end':
      return before.history.gestureBase && adjusted('drag', before.history.gestureBase, now);
    case 'set-range':
      return {
        event: 'range_set',
        fields: { from: action.from, to: action.to, state: action.state },
      };
    case 'delete-boundary':
      return { event: 'boundary_deleted', fields: { frame: was.boundaries[action.index]?.frame } };
    case 'delete-selected': {
      if (before.selected !== null) {
        return { event: 'boundary_deleted', fields: { frame: before.selected } };
      }
      const interval = selectedInterval(before);
      return {
        event: 'range_set',
        fields: { from: interval?.start, to: interval?.end, state: 'cut' },
      };
    }
    case 'undo':
    case 'redo':
      return { event: action.type, fields: {} };
    default:
      return null;
  }
}

/** `boundary_adjusted` for the boundary whose frame changed, if one did (moves keep the order). */
function adjusted(how: string, was: Timeline, now: Timeline): EditEvent | null {
  const index = was.boundaries.findIndex((b, i) => b.frame !== now.boundaries[i]?.frame);
  if (index < 0) return null;
  const fields = { how, from: was.boundaries[index]?.frame, to: now.boundaries[index]?.frame };
  return { event: 'boundary_adjusted', fields };
}
