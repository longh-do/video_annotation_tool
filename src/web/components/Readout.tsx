import { useMemo } from 'react';
import type { FrameMap } from '../../core/frame-map.ts';
import { segments, type Timeline } from '../../core/timeline.ts';
import { clock } from '../format.ts';
import type { Player } from '../player/player.ts';
import { usePlayer } from '../player/use-player.ts';
import { StateChip } from './StateChip.tsx';

interface ReadoutProps {
  readonly player: Player | null;
  readonly timeline: Timeline;
  readonly frames: FrameMap;
}

/** The state chip, time and frame number at the playhead; updates with every presented frame. */
export function Readout({ player, timeline, frames }: ReadoutProps) {
  const shown = usePlayer(player, (s) => s.frame);
  const runs = useMemo(() => segments(timeline), [timeline]);
  const frame = Math.max(shown, 0);
  const seconds = (frames.ptsUs[frame] ?? 0) / 1e6;
  const duration = (frames.ptsUs[frames.ptsUs.length - 1] ?? 0) / 1e6;
  return (
    <>
      <StateChip runs={runs} frames={frames} frame={frame} />
      <span className="time" data-frame={shown}>
        {clock(seconds)} / {clock(duration)} · frame {frame}
      </span>
    </>
  );
}
