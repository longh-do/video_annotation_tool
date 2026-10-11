import { type FrameMap, frameNs } from '../../core/frame-map.ts';
import { durationSeconds } from '../../core/ns.ts';
import type { Segment } from '../../core/timeline.ts';
import { clock } from '../format.ts';

interface StateChipProps {
  readonly runs: readonly Segment[];
  readonly frames: FrameMap;
  readonly frame: number;
}

/**
 * "● KEEP 0:12.4": the state at the playhead and how long it has lasted. Colour and pattern differ.
 */
export function StateChip({ runs, frames, frame }: StateChipProps) {
  const run = runs.find((s) => s.start <= frame && frame < s.end);
  const state = run?.state ?? 'cut';
  const lasted = run ? durationSeconds(frameNs(frames, frame) - frameNs(frames, run.start)) : 0;
  return (
    <span className={`state-chip state-${state}`} data-state={state}>
      {state === 'keep' ? '● KEEP' : '✂ CUT'} {clock(lasted)}
    </span>
  );
}
