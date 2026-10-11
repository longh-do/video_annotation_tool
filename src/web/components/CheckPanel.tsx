import { useMemo } from 'react';
import { boundariesToCheck, shortSegments } from '../../core/check.ts';
import { type FrameMap, frameNs, stopNs } from '../../core/frame-map.ts';
import { durationSeconds } from '../../core/ns.ts';
import type { Timeline } from '../../core/timeline.ts';
import type { FrameGrabber } from '../player/frame-grabber.ts';
import type { Player } from '../player/player.ts';
import { usePlayer } from '../player/use-player.ts';
import { Filmstrip } from './Filmstrip.tsx';

/** A keep or cut shorter than this is probably a double tap or a slip. */
const SHORT_NS = 500_000_000n;

interface CheckPanelProps {
  readonly player: Player | null;
  readonly grabber: FrameGrabber | null;
  readonly timeline: Timeline;
  readonly frames: FrameMap;
  readonly selected: number | null;
  readonly anchor: number | null;
  readonly onPick: (frame: number) => void;
  readonly onVisit: (frame: number) => void;
}

/**
 * The check pass, under the video: how many rough marks are left, very short runs to look at, and
 * while paused on a boundary, the frames around it.
 */
export function CheckPanel(props: CheckPanelProps) {
  const { player, timeline, frames, selected, anchor } = props;
  const paused = usePlayer(player, (s) => !s.playing);
  const left = useMemo(() => boundariesToCheck(timeline).length, [timeline]);
  const short = useMemo(() => shortSegments(timeline, frames, SHORT_NS), [timeline, frames]);
  // Re-renders only when the playhead enters or leaves a short run, not every frame.
  const here = usePlayer(player, (s) =>
    short.findIndex((r) => r.start <= s.frame && s.frame < r.end),
  );
  const run = short[here];

  return (
    <section className="check" aria-label="Check pass">
      <p className="check-status">
        {left > 0
          ? `${left} rough ${left === 1 ? 'mark' : 'marks'} to check: Enter goes to the next one.`
          : timeline.boundaries.length > 0
            ? 'Every boundary is checked.'
            : 'Press S where a task starts, D where it ends.'}{' '}
        {short.length > 0 && !run && (
          <button
            type="button"
            className="check-warning"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onVisit(short[0]!.start)}
          >
            {short.length} very short {short.length === 1 ? 'run' : 'runs'}: show
          </button>
        )}
        {run && (
          <span className="check-warning">
            This {run.state} lasts only{' '}
            {durationSeconds(stopNs(frames, run.end) - frameNs(frames, run.start)).toFixed(2)} s. X
            flips it to {run.state === 'keep' ? 'cut' : 'keep'}.
          </span>
        )}
      </p>
      {paused && selected !== null && anchor !== null && (
        <Filmstrip
          key={anchor}
          grabber={props.grabber}
          frames={frames}
          anchor={anchor}
          boundary={selected}
          onPick={props.onPick}
        />
      )}
    </section>
  );
}
