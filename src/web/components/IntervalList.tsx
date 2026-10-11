import { useMemo } from 'react';
import { type FrameMap, frameNs, stopNs } from '../../core/frame-map.ts';
import { durationSeconds } from '../../core/ns.ts';
import { keepSegments, type Timeline } from '../../core/timeline.ts';
import { clock } from '../format.ts';
import type { Player } from '../player/player.ts';
import { usePlayer } from '../player/use-player.ts';

interface IntervalListProps {
  readonly player: Player | null;
  readonly timeline: Timeline;
  readonly frames: FrameMap;
  readonly onSelect: (frame: number) => void;
}

/** Every kept interval, for direct navigation on long recordings. Rough ends are marked. */
export function IntervalList({ player, timeline, frames, onSelect }: IntervalListProps) {
  const intervals = useMemo(() => keepSegments(timeline), [timeline]);
  // Re-renders when the playhead moves into another interval, not with every frame.
  const current = usePlayer(player, (s) =>
    intervals.findIndex((i) => i.start <= s.frame && s.frame < i.end),
  );
  if (intervals.length === 0) {
    return <p className="empty">No kept intervals yet. Press S where a task starts.</p>;
  }
  const rough = (frame: number) => timeline.boundaries.some((b) => b.frame === frame && !b.checked);
  const time = (frame: number) =>
    clock((frames.ptsUs[Math.min(frame, frames.ptsUs.length - 1)] ?? 0) / 1e6);
  return (
    <ol className="intervals">
      {intervals.map((interval, i) => {
        const seconds = durationSeconds(
          stopNs(frames, interval.end) - frameNs(frames, interval.start),
        );
        return (
          <li key={interval.start}>
            <button
              type="button"
              className={`interval${i === current ? ' interval-current' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(interval.start)}
            >
              <span className="interval-index">{i + 1}</span>
              <span>
                {time(interval.start)} –{' '}
                {interval.end >= timeline.frameCount ? 'end' : time(interval.end)}
              </span>
              <span className="interval-length">{seconds.toFixed(1)} s</span>
              {(rough(interval.start) || rough(interval.end)) && (
                <span className="interval-rough">rough</span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
