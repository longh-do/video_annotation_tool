import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { keepIntervals } from '../../src/core/annotation.ts';
import { frameRanges, scoreRanges, summarizeErrors } from '../../src/core/score.ts';
import { keepSegments } from '../../src/core/timeline.ts';
import { frameMap, recordingArb } from './synthetic.ts';

// 100 frames, 40 ms apart.
const frames = frameMap(2_000_000_000n, new Array(99).fill(40_000));
const range = (start: number, end: number) => ({ start, end });

describe('scoreRanges', () => {
  test('separates boundary jitter from interval mistakes', () => {
    const gold = [range(10, 20), range(30, 40), range(50, 60)];
    const test = [range(12, 19), range(32, 60), range(80, 85)];
    const score = scoreRanges(gold, test, frames);
    expect(score).toMatchObject({
      goldIntervals: 3,
      testIntervals: 3,
      startErrors: [2], // only the clean pair: the merged interval says nothing about jitter
      endErrors: [-1],
      missed: 0,
      extra: 1,
      merged: 1,
      split: 0,
    });
    expect(score.falseKeepSeconds).toBeCloseTo(0.6, 5); // frames 40–49 and 80–84
    expect(score.falseCutSeconds).toBeCloseTo(0.2, 5); // frames 10–11, 19, 30–31
  });

  test('counts a gold interval nobody marked as missed', () => {
    expect(scoreRanges([range(10, 20), range(30, 40)], [range(10, 20)], frames)).toMatchObject({
      missed: 1,
      extra: 0,
      startErrors: [0],
    });
  });

  test('counts one gold interval marked as two as split, without boundary errors', () => {
    const score = scoreRanges([range(10, 40)], [range(10, 20), range(25, 40)], frames);
    expect(score).toMatchObject({ split: 1, merged: 0, startErrors: [], endErrors: [] });
  });

  test('scores touching intervals as the one interval they keep', () => {
    const score = scoreRanges([range(10, 20), range(20, 30)], [range(10, 30)], frames);
    expect(score).toMatchObject({ goldIntervals: 1, merged: 0, startErrors: [0], endErrors: [0] });
  });

  test('handles END and empty annotations', () => {
    expect(scoreRanges([range(90, 100)], [range(92, 100)], frames).startErrors).toEqual([2]);
    expect(scoreRanges([], [], frames)).toMatchObject({ missed: 0, extra: 0, falseKeepSeconds: 0 });
  });

  test('an annotation scored against itself is perfect', () => {
    fc.assert(
      fc.property(recordingArb(), ({ frames, timeline }) => {
        const ranges = frameRanges(keepIntervals(timeline, frames), frames);
        expect(ranges).toEqual(keepSegments(timeline).map((s) => range(s.start, s.end)));
        const score = scoreRanges(ranges, ranges, frames);
        expect(score).toMatchObject({ missed: 0, extra: 0, merged: 0, split: 0 });
        expect(score.startErrors).toHaveLength(ranges.length);
        expect([...score.startErrors, ...score.endErrors].every((e) => e === 0)).toBe(true);
        expect(score.falseKeepSeconds + score.falseCutSeconds).toBe(0);
      }),
    );
  });
});

test('summarizeErrors reports nearest-rank percentiles and the signed bias', () => {
  expect(summarizeErrors([2, -18, 0, -1])).toEqual({
    count: 4,
    medianAbs: 1,
    p90Abs: 18,
    meanSigned: -4.25,
  });
  expect(summarizeErrors([])).toEqual({ count: 0, medianAbs: 0, p90Abs: 0, meanSigned: 0 });
});
