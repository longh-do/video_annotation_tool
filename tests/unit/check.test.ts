import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  boundariesToCheck,
  filmstripFrames,
  nextToCheck,
  shortSegments,
} from '../../src/core/check.ts';
import { frameCount, frameNs } from '../../src/core/frame-map.ts';
import {
  emptyTimeline,
  markChecked,
  setStateFrom,
  type Timeline,
} from '../../src/core/timeline.ts';
import { frameMap, frameMapArb } from './synthetic.ts';

const live = (t: Timeline, frame: number, state: 'keep' | 'cut') =>
  setStateFrom(t, frame, state, 'live');

describe('which boundaries the check pass visits', () => {
  // live keep @10, paused cut @20, live keep @30, live cut @40, then a through boundary @50
  let t = emptyTimeline(100);
  t = live(t, 10, 'keep');
  t = setStateFrom(t, 20, 'cut', 'paused');
  t = live(t, 30, 'keep');
  t = live(t, 50, 'cut');
  t = live(t, 40, 'cut');

  test('only live, unconfirmed boundaries that change the output', () => {
    expect(boundariesToCheck(t).map((i) => t.boundaries[i]!.frame)).toEqual([10, 30, 40]);
    expect(boundariesToCheck(markChecked(t, 0)).map((i) => t.boundaries[i]!.frame)).toEqual([
      30, 40,
    ]);
  });

  test('advance to the next one, wrapping around, until none is left', () => {
    const frameOf = (i: number) => t.boundaries[i]?.frame;
    expect(frameOf(nextToCheck(t, 10))).toBe(30);
    expect(frameOf(nextToCheck(t, 40))).toBe(10);
    expect(frameOf(nextToCheck(t, 0))).toBe(10);
    const done = [0, 2, 3].reduce(markChecked, t);
    expect(nextToCheck(done, 0)).toBe(-1);
  });
});

describe('short segments', () => {
  // 60 frames, 40 ms apart.
  const frames = frameMap(1_000_000_000n, new Array(59).fill(40_000));

  test('inner runs under the threshold are reported; runs at either end are not', () => {
    let t = emptyTimeline(60);
    t = setStateFrom(t, 1, 'keep', 'live'); // a 40 ms cut at the start: fine
    t = setStateFrom(t, 20, 'cut', 'live');
    t = setStateFrom(t, 22, 'keep', 'live'); // an 80 ms cut between two keeps: suspicious
    t = setStateFrom(t, 59, 'cut', 'live'); // a 40 ms cut at the end: fine
    expect(shortSegments(t, frames, 500_000_000n)).toEqual([{ start: 20, end: 22, state: 'cut' }]);
    expect(shortSegments(t, frames, 50_000_000n)).toEqual([]);
  });
});

describe('filmstrip', () => {
  test('about 1.5 s before to 0.5 s after the boundary, one thumbnail every ~167 ms', () => {
    const frames = frameMap(5_000_000_000n, new Array(299).fill(33_333)); // 10 s at 30 fps
    const strip = filmstripFrames(frames, 150);
    expect(strip).toHaveLength(13);
    expect(strip).toContain(150);
    expect(strip[0]).toBe(105);
    expect(strip.at(-1)).toBe(165);
  });

  test('near the start it shrinks instead of repeating frames', () => {
    const frames = frameMap(5_000_000_000n, new Array(299).fill(33_333));
    expect(filmstripFrames(frames, 2)).toEqual([0, 2, 7, 12, 17]);
  });

  test('always holds the boundary frame, sorted, unique, and within the window', () => {
    const input = frameMapArb(300).chain((frames) =>
      fc.tuple(fc.constant(frames), fc.nat({ max: frameCount(frames) - 1 })),
    );
    fc.assert(
      fc.property(input, ([frames, frame]) => {
        const strip = filmstripFrames(frames, frame);
        expect(strip).toContain(frame);
        expect(new Set(strip).size).toBe(strip.length);
        expect([...strip].sort((a, b) => a - b)).toEqual(strip);
        // Within one video part, every pick lies inside the window (give or take a frame gap).
        if (frames.parts.length > 1) return;
        const center = frameNs(frames, frame);
        const maxGapNs = 102_000_000n;
        for (const f of strip) {
          const offset = frameNs(frames, f) - center;
          expect(offset >= -1_500_000_000n - maxGapNs && offset <= 500_000_000n + maxGapNs).toBe(
            true,
          );
        }
      }),
    );
  });
});
