import { useMemo } from 'react';
import { type FrameMap, frameNs, stopNs } from '../../core/frame-map.ts';
import { durationSeconds } from '../../core/ns.ts';
import { keepSegments, type Segment, type Timeline } from '../../core/timeline.ts';
import { clock } from '../format.ts';
import type { Player } from '../player/player.ts';
import { usePlayer } from '../player/use-player.ts';

interface IntervalListProps {
  readonly player: Player | null;
  readonly timeline: Timeline;
  readonly frames: FrameMap;
  /** Start of the selected interval, if one is selected. */
  readonly selected: number | null;
  readonly onSelect: (interval: Segment) => void;
  /** A right-click on an interval: the same menu as on the timeline. */
  readonly onMenu: (interval: Segment, at: { readonly x: number; readonly y: number }) => void;
}

const NEEDS_CHECK =
  'Marked while the video played, so this boundary may be a few frames late. Press Enter to check it.';

/**
 * Every kept interval, for direct navigation on long recordings. A click selects the interval and
 * shows its start; the one under the playhead is outlined. Ends still to check say so.
 */
export function IntervalList(props: IntervalListProps) {
  const { player, timeline, frames, selected } = props;
  const intervals = useMemo(() => keepSegments(timeline), [timeline]);
  // Re-renders when the playhead moves into another interval, not with every frame.
  const current = usePlayer(player, (s) =>
    intervals.findIndex((i) => i.start <= s.frame && s.frame < i.end),
  );
  if (intervals.length === 0) return <p className="empty">No kept intervals yet.</p>;
  const unchecked = (frame: number) =>
    timeline.boundaries.some((b) => b.frame === frame && !b.checked);
  const time = (frame: number) =>
    clock((frames.ptsUs[Math.min(frame, frames.ptsUs.length - 1)] ?? 0) / 1e6);
  return (
    <ol className="intervals">
      {intervals.map((interval, i) => {
        const seconds = durationSeconds(
          stopNs(frames, interval.end) - frameNs(frames, interval.start),
        );
        const classes = [
          'interval',
          i === current ? 'interval-current' : '',
          interval.start === selected ? 'interval-selected' : '',
        ];
        return (
          <li key={interval.start}>
            <button
              type="button"
              className={classes.join(' ')}
              aria-pressed={interval.start === selected}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onSelect(interval)}
              onContextMenu={(event) => {
                event.preventDefault();
                props.onMenu(interval, { x: event.clientX, y: event.clientY });
              }}
            >
              <span className="interval-index">{i + 1}</span>
              <span className="interval-times">
                {time(interval.start)} –{' '}
                {interval.end >= timeline.frameCount ? 'end' : time(interval.end)}
              </span>
              <span className="interval-length">{seconds.toFixed(1)} s</span>
              {(unchecked(interval.start) || unchecked(interval.end)) && (
                <span className="needs-check" title={NEEDS_CHECK}>
                  needs check
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
