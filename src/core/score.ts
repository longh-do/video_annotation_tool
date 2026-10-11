/**
 * Scoring an annotation against a gold annotation of the same recording.
 *
 * Boundary errors are in frames of the reference camera, signed (positive = late), with starts
 * and ends kept apart: ends are an absence judgement ("the task has stopped") and run looser than
 * starts. They come only from clean pairs, one test interval overlapping exactly one gold interval
 * and vice versa. Interval mistakes (missed, extra, merged, split) are counted on their own, and
 * footage kept or cut by mistake is summed in seconds. The tool only computes; the pass/fail
 * thresholds belong to each task's QA settings.
 */
import type { KeepInterval } from './annotation.ts';
import { type FrameMap, frameNs, positionAtNs, stopNs } from './frame-map.ts';
import { durationSeconds, parseNs } from './ns.ts';

/** Positions [start, end) on the reference camera; `end` may be END. */
export interface FrameRange {
  readonly start: number;
  readonly end: number;
}

export interface Score {
  readonly goldIntervals: number;
  readonly testIntervals: number;
  /** For each clean pair: test − gold, in frames. */
  readonly startErrors: readonly number[];
  readonly endErrors: readonly number[];
  /** Gold intervals that no test interval overlaps. */
  readonly missed: number;
  /** Test intervals that overlap no gold interval. */
  readonly extra: number;
  /** Test intervals that overlap two or more gold intervals. */
  readonly merged: number;
  /** Gold intervals that two or more test intervals overlap. */
  readonly split: number;
  /** Kept in the test but cut in gold, and the reverse. */
  readonly falseKeepSeconds: number;
  readonly falseCutSeconds: number;
}

export function frameRanges(intervals: readonly KeepInterval[], frames: FrameMap): FrameRange[] {
  return intervals.map((interval) => ({
    start: positionAtNs(frames, parseNs(interval.start_ns)),
    end: positionAtNs(frames, parseNs(interval.end_ns)),
  }));
}

/** Both lists must be sorted and non-overlapping, as in every valid annotation. */
export function scoreRanges(
  gold: readonly FrameRange[],
  test: readonly FrameRange[],
  frames: FrameMap,
): Score {
  const g = joinTouching(gold);
  const t = joinTouching(test);
  const toNs = (r: FrameRange) => ({ start: frameNs(frames, r.start), end: stopNs(frames, r.end) });
  const gNs = g.map(toNs);
  const tNs = t.map(toNs);

  // Every overlapping (gold, test) pair, by a sweep over both sorted lists.
  const overlaps: { gold: number; test: number; ns: bigint }[] = [];
  for (let i = 0, j = 0; i < gNs.length && j < tNs.length; ) {
    const a = gNs[i]!;
    const b = tNs[j]!;
    const ns = min(a.end, b.end) - max(a.start, b.start);
    if (ns > 0n) overlaps.push({ gold: i, test: j, ns });
    if (a.end <= b.end) i++;
    else j++;
  }
  const hits = (side: 'gold' | 'test', count: number) =>
    Array.from({ length: count }, (_, i) => overlaps.filter((o) => o[side] === i).length);
  const goldHits = hits('gold', g.length);
  const testHits = hits('test', t.length);
  const pairs = overlaps.filter((o) => goldHits[o.gold] === 1 && testHits[o.test] === 1);

  const overlapNs = sum(overlaps.map((o) => o.ns));
  return {
    goldIntervals: g.length,
    testIntervals: t.length,
    startErrors: pairs.map((p) => t[p.test]!.start - g[p.gold]!.start),
    endErrors: pairs.map((p) => t[p.test]!.end - g[p.gold]!.end),
    missed: goldHits.filter((n) => n === 0).length,
    extra: testHits.filter((n) => n === 0).length,
    merged: testHits.filter((n) => n >= 2).length,
    split: goldHits.filter((n) => n >= 2).length,
    falseKeepSeconds: durationSeconds(sum(tNs.map((r) => r.end - r.start)) - overlapNs),
    falseCutSeconds: durationSeconds(sum(gNs.map((r) => r.end - r.start)) - overlapNs),
  };
}

export interface ErrorSummary {
  readonly count: number;
  /** Nearest-rank percentiles of the absolute error. */
  readonly medianAbs: number;
  readonly p90Abs: number;
  /** Mean signed error: a systematic lean early (negative) or late (positive). */
  readonly meanSigned: number;
}

export function summarizeErrors(errors: readonly number[]): ErrorSummary {
  const abs = errors.map(Math.abs).sort((a, b) => a - b);
  const rank = (p: number) => abs[Math.max(Math.ceil(p * abs.length) - 1, 0)] ?? 0;
  const meanSigned = errors.length === 0 ? 0 : errors.reduce((a, b) => a + b, 0) / errors.length;
  return { count: errors.length, medianAbs: rank(0.5), p90Abs: rank(0.9), meanSigned };
}

/** Intervals that touch keep the same frames as one interval, so they are scored as one. */
function joinTouching(ranges: readonly FrameRange[]): FrameRange[] {
  const joined: FrameRange[] = [];
  for (const r of ranges) {
    const last = joined.at(-1);
    if (last && last.end === r.start) joined[joined.length - 1] = { start: last.start, end: r.end };
    else joined.push(r);
  }
  return joined;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((a, b) => a + b, 0n);
}
