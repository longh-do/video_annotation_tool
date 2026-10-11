import { useMemo } from 'react';
import { boundariesToCheck, shortSegments } from '../../core/check.ts';
import { type FrameMap, frameNs, stopNs } from '../../core/frame-map.ts';
import { durationSeconds } from '../../core/ns.ts';
import type { Segment, Timeline } from '../../core/timeline.ts';
import { type Command, keysOf } from '../keymap.ts';
import type { Player } from '../player/player.ts';
import { usePlayer } from '../player/use-player.ts';
import { Filmstrip, type Pictures } from './Filmstrip.tsx';

/** A keep or cut shorter than this is probably a double tap or a slip. */
const SHORT_NS = 500_000_000n;

interface CheckPanelProps {
  readonly player: Player | null;
  /** The filmstrip's pictures: the camera shown big. */
  readonly pictures: Pictures | null;
  readonly timeline: Timeline;
  readonly frames: FrameMap;
  readonly selected: number | null;
  readonly anchor: number | null;
  readonly onPick: (frame: number) => void;
  readonly onVisit: (frame: number) => void;
  /** Takes a very short run away: it gets the state around it. */
  readonly onRemove: (run: Segment) => void;
  readonly onRun: (command: Command) => void;
}

/**
 * The check pass, under the video: how many marks still need checking (marks made while the
 * video played land a few frames late), very short runs to look at, and while paused on a
 * boundary, the frames around it. The button does what Enter does.
 */
export function CheckPanel(props: CheckPanelProps) {
  const { player, timeline, frames, selected, anchor } = props;
  const paused = usePlayer(player, (s) => !s.playing);
  const onSelected = usePlayer(player, (s) => !s.playing && s.frame === selected);
  const left = useMemo(() => boundariesToCheck(timeline).length, [timeline]);
  const short = useMemo(() => shortSegments(timeline, frames, SHORT_NS), [timeline, frames]);
  // Re-renders only when the playhead enters or leaves a short run, not every frame.
  const here = usePlayer(player, (s) =>
    short.findIndex((r) => r.start <= s.frame && s.frame < r.end),
  );
  const run = short[here];
  const boundary = timeline.boundaries.find((b) => b.frame === selected);
  const checking = onSelected && boundary !== undefined && !boundary.checked;

  return (
    <section className="check" aria-label="Check pass">
      <p className="check-status">
        {checking
          ? `${left} ${left === 1 ? 'mark needs' : 'marks need'} checking. Move this one with , and . or a click on a frame below.`
          : left > 0
            ? `${left} ${left === 1 ? 'mark needs' : 'marks need'} checking: made while the video played, they may be a few frames late.`
            : timeline.boundaries.length > 0 && 'Every boundary is checked.'}{' '}
        {left > 0 && (
          <button
            type="button"
            className="check-button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onRun('accept')}
          >
            {checking ? 'Accept, go to the next' : 'Check the next mark'}{' '}
            <kbd>{keysOf('accept')}</kbd>
          </button>
        )}{' '}
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
            {durationSeconds(stopNs(frames, run.end) - frameNs(frames, run.start)).toFixed(2)} s.{' '}
            <button
              type="button"
              className="check-warning"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onRemove(run)}
            >
              Remove it
            </button>
          </span>
        )}
      </p>
      {paused && selected !== null && anchor !== null && props.pictures && (
        <Filmstrip
          key={`${props.pictures.camera}:${anchor}`}
          pictures={props.pictures}
          frames={frames}
          anchor={anchor}
          boundary={selected}
          state={boundary?.state ?? 'keep'}
          onPick={props.onPick}
        />
      )}
    </section>
  );
}
