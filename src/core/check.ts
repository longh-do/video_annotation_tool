/**
 * The check pass: after marking at speed, visit each rough (live) boundary once, put it on the
 * exact frame, and confirm it. Boundaries set while paused are exact already and are skipped.
 */
import { type FrameMap, frameNs, nearestFrame, stopNs } from './frame-map.ts';
import { isThrough, type Segment, segments, type Timeline } from './timeline.ts';

/** Indices of boundaries still to check: live, unconfirmed, and not through boundaries. */
export function boundariesToCheck(t: Timeline): number[] {
  return t.boundaries.flatMap((b, i) => (!b.checked && !isThrough(t, i) ? [i] : []));
}

/** The first boundary to check after `frame`, wrapping to the start; -1 when none is left. */
export function nextToCheck(t: Timeline, frame: number): number {
  const pending = boundariesToCheck(t);
  return pending.find((i) => t.boundaries[i]!.frame > frame) ?? pending[0] ?? -1;
}

/**
 * Inner runs (not touching the start or end of the recording) shorter than `minNs`. A keep or
 * cut that short is usually a double tap or a slip, so the check pass points it out.
 */
export function shortSegments(t: Timeline, frames: FrameMap, minNs: bigint): Segment[] {
  return segments(t).filter(
    (s) =>
      s.start > 0 &&
      s.end < t.frameCount &&
      stopNs(frames, s.end) - frameNs(frames, s.start) < minNs,
  );
}

/** Filmstrip spacing and extent: one thumbnail every 1/6 s, 9 before the boundary, 3 after. */
const FILMSTRIP_STEP_NS = 166_666_667n;
const FILMSTRIP_BEFORE = 9;
const FILMSTRIP_AFTER = 3;

/**
 * Frames for the check filmstrip around the boundary at `frame`: about 1.5 s before to 0.5 s after
 * it, because live marks land late (reaction time × playback speed) and the true boundary is
 * usually just before the mark. Evenly spaced in time, snapped to the nearest real frame (the
 * videos have a variable frame rate), without duplicates, always including the boundary frame.
 */
export function filmstripFrames(frames: FrameMap, frame: number): number[] {
  const center = frameNs(frames, frame);
  const picks = new Set<number>();
  for (let k = -FILMSTRIP_BEFORE; k <= FILMSTRIP_AFTER; k++) {
    picks.add(nearestFrame(frames, center + BigInt(k) * FILMSTRIP_STEP_NS));
  }
  return [...picks].sort((a, b) => a - b);
}
