/** The right-click menu of a stretch of the recording, on the timeline or in the interval list. */
import { keepSegments, type Segment, type State, type Timeline } from '../core/timeline.ts';
import type { MenuItem } from './components/Menu.tsx';
import { keysOf } from './keymap.ts';

export interface StretchMenu {
  readonly label: string;
  readonly items: readonly (MenuItem | null)[];
}

interface MenuActions {
  readonly setRange: (from: number, to: number, state: State) => void;
  readonly deleteInterval: (interval: Segment) => void;
}

/**
 * Only what can be done with that stretch: a cut can be kept; a kept interval can be merged with
 * its neighbours or deleted.
 */
export function stretchMenu(
  segment: Segment,
  timeline: Timeline,
  editable: boolean,
  act: MenuActions,
): StretchMenu {
  if (segment.state === 'cut') {
    return {
      label: 'Cut stretch',
      items: [
        {
          label: 'Keep this part',
          disabled: !editable,
          run: () => act.setRange(segment.start, segment.end, 'keep'),
        },
      ],
    };
  }
  const kept = keepSegments(timeline);
  const i = kept.findIndex((s) => s.start === segment.start);
  const previous = kept[i - 1];
  const next = kept[i + 1];
  return {
    label: 'Interval',
    items: [
      {
        label: 'Merge with the previous interval',
        disabled: !editable || !previous,
        run: () => previous && act.setRange(previous.end, segment.start, 'keep'),
      },
      {
        label: 'Merge with the next interval',
        disabled: !editable || !next,
        run: () => next && act.setRange(segment.end, next.start, 'keep'),
      },
      null,
      {
        label: 'Delete interval',
        danger: true,
        keys: keysOf('deleteSelected').split(' or ')[0],
        disabled: !editable,
        run: () => act.deleteInterval(segment),
      },
    ],
  };
}
