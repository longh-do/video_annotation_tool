/**
 * The check pass: after marking at speed, visit each rough (live) boundary once, put it on the
 * exact frame, and confirm it. Boundaries set while paused are exact already and are skipped.
 */
import { type FrameMap, frameNs, stopNs } from './frame-map.ts';
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
