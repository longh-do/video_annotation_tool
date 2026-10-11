/**
 * Telemetry for edits, derived from the editor's actions in one place rather than logged from
 * every key and click. Event names follow the plan's event list (G2).
 */
import type { Timeline } from '../core/timeline.ts';
import type { EditorAction, EditorState } from './editor.ts';

export interface EditEvent {
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * The events for an action that changed the editor. A rough mark that ends up checked, whether by
 * Enter or by moving it, also yields `boundary_accepted`: the check pass is measured per boundary.
 */
export function editEvents(
  action: EditorAction,
  before: EditorState,
  after: EditorState,
): EditEvent[] {
  const was = before.history.present;
  const now = after.history.present;
  const events: EditEvent[] = [];
  switch (action.type) {
    case 'mark':
      events.push({
        event: 'boundary_set',
        fields: { frame: action.frame, state: action.state, origin: action.origin },
      });
      break;
    case 'move':
      // A drag's every step is not worth an event; its end is.
      if (action.origin !== 'drag') events.push(...adjusted('filmstrip', was, now));
      break;
    case 'nudge':
      events.push(...adjusted('nudge', was, now));
      break;
    case 'move-nearest':
      events.push(...adjusted('move_here', was, now));
      break;
    case 'drag-end':
      if (before.history.gestureBase)
        events.push(...adjusted('drag', before.history.gestureBase, now));
      break;
    case 'flip':
      events.push({ event: 'segment_flipped', fields: { frame: action.frame } });
      break;
    case 'delete-selected':
      events.push({ event: 'boundary_deleted', fields: { frame: before.selected } });
      break;
    case 'undo':
    case 'redo':
      events.push({ event: action.type, fields: {} });
      break;
  }
  // Undo can't check a boundary, and a drag is accepted when it ends.
  if (action.type !== 'undo' && action.type !== 'redo' && after.history.gestureBase === null) {
    const base = before.history.gestureBase ?? was;
    for (const [i, boundary] of now.boundaries.entries()) {
      const old = base.boundaries[i];
      if (boundary.checked && old && !old.checked && old.state === boundary.state) {
        events.push({
          event: 'boundary_accepted',
          fields: {
            frame: boundary.frame,
            how: action.type === 'confirm' ? 'enter' : boundary.origin,
          },
        });
      }
    }
  }
  return events;
}

/** `boundary_adjusted` for the boundary whose frame changed, if one did. */
function adjusted(how: string, was: Timeline, now: Timeline): EditEvent[] {
  const index = was.boundaries.findIndex((b, i) => b.frame !== now.boundaries[i]?.frame);
  if (index < 0) return [];
  const fields = { how, from: was.boundaries[index]?.frame, to: now.boundaries[index]?.frame };
  return [{ event: 'boundary_adjusted', fields }];
}
