import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  boundaryIndexAt,
  clearAll,
  deleteBoundary,
  emptyTimeline,
  flipSegmentAt,
  isThrough,
  keepSegments,
  markChecked,
  moveBoundary,
  nearestBoundary,
  segments,
  setStateFrom,
  stateAt,
  type Timeline,
} from '../../src/core/timeline.ts';
import { frameStates, timelineArb } from './synthetic.ts';

const FRAMES = 100;
const empty = emptyTimeline(FRAMES);
const keep = (t: Timeline, frame: number) => setStateFrom(t, frame, 'keep', 'paused');
const cut = (t: Timeline, frame: number) => setStateFrom(t, frame, 'cut', 'paused');
const frames = (t: Timeline) => t.boundaries.map((b) => b.frame);

describe('S and D set the state from a frame on', () => {
  test('S … D makes one keep interval [S, D)', () => {
    const t = cut(keep(empty, 10), 40);
    expect(keepSegments(t)).toEqual([{ start: 10, end: 40, state: 'keep' }]);
    expect(stateAt(t, 9)).toBe('cut');
    expect(stateAt(t, 10)).toBe('keep');
    expect(stateAt(t, 39)).toBe('keep');
    expect(stateAt(t, 40)).toBe('cut');
  });

  test('pressing S again while keeping changes nothing, so double taps are harmless', () => {
    const t = keep(empty, 10);
    expect(keep(t, 10)).toBe(t);
    expect(keep(t, 25)).toBe(t);
    expect(cut(empty, 5)).toBe(empty);
  });

  test('a keep without a later D runs to END', () => {
    expect(keepSegments(keep(empty, 90))).toEqual([{ start: 90, end: FRAMES, state: 'keep' }]);
  });

  test('a mark on an existing boundary replaces it', () => {
    const t = keep(cut(keep(empty, 10), 40), 40);
    expect(frames(t)).toEqual([10, 40]);
    expect(keepSegments(t)).toEqual([{ start: 10, end: FRAMES, state: 'keep' }]);
  });

  test('an early D leaves the later D as a through boundary that comes back when needed', () => {
    const original = cut(keep(empty, 10), 40);
    const early = cut(original, 25);
    expect(frames(early)).toEqual([10, 25, 40]);
    expect(isThrough(early, 2)).toBe(true);
    expect(keepSegments(early)).toEqual([{ start: 10, end: 25, state: 'keep' }]);
    // Deleting the early D restores the original interval instead of keeping to END.
    expect(keepSegments(deleteBoundary(early, 1))).toEqual(keepSegments(original));
  });

  test('live marks need checking; paused marks are exact', () => {
    const t = setStateFrom(setStateFrom(empty, 10, 'keep', 'live'), 40, 'cut', 'paused');
    expect(t.boundaries.map((b) => b.checked)).toEqual([false, true]);
  });
});

describe('corrections', () => {
  const t = cut(keep(cut(keep(empty, 10), 40), 60), 80);

  test('moving a boundary stops at its neighbours', () => {
    expect(frames(moveBoundary(t, 1, 45, 'nudge'))).toEqual([10, 45, 60, 80]);
    expect(frames(moveBoundary(t, 1, 99, 'drag'))).toEqual([10, 59, 60, 80]);
    expect(frames(moveBoundary(t, 0, -5, 'drag'))).toEqual([0, 40, 60, 80]);
    expect(frames(moveBoundary(t, 3, 500, 'drag'))).toEqual([10, 40, 60, 99]);
    expect(moveBoundary(t, 1, 40, 'nudge')).toBe(t);
  });

  test('moving a live mark checks it, unless it is moved live again', () => {
    const live = setStateFrom(empty, 10, 'keep', 'live');
    expect(moveBoundary(live, 0, 8, 'nudge').boundaries[0]).toMatchObject({ checked: true });
    expect(moveBoundary(live, 0, 12, 'live').boundaries[0]).toMatchObject({ checked: false });
  });

  test('choosing the frame a live mark already sits on confirms it', () => {
    const live = setStateFrom(empty, 10, 'keep', 'live');
    expect(moveBoundary(live, 0, 10, 'placed').boundaries[0]).toMatchObject({
      frame: 10,
      origin: 'live',
      checked: true,
    });
    expect(moveBoundary(live, 0, 10, 'live')).toBe(live);
  });

  test('X flips the run under the playhead', () => {
    expect(keepSegments(flipSegmentAt(t, 50))).toEqual([{ start: 10, end: 80, state: 'keep' }]);
    expect(keepSegments(flipSegmentAt(t, 20))).toEqual([{ start: 60, end: 80, state: 'keep' }]);
  });

  test('X before the first boundary keeps from frame 0', () => {
    expect(keepSegments(flipSegmentAt(t, 3))).toEqual([
      { start: 0, end: 40, state: 'keep' },
      { start: 60, end: 80, state: 'keep' },
    ]);
  });

  test('deleting a boundary merges its neighbours', () => {
    expect(keepSegments(deleteBoundary(t, 1))).toEqual([{ start: 10, end: 80, state: 'keep' }]);
  });

  test('confirming a boundary in the check pass', () => {
    const live = setStateFrom(empty, 10, 'keep', 'live');
    const checked = markChecked(live, 0);
    expect(checked.boundaries[0]?.checked).toBe(true);
    expect(markChecked(checked, 0)).toBe(checked);
  });

  test('N cuts everything', () => {
    expect(keepSegments(clearAll(t))).toEqual([]);
    expect(clearAll(empty)).toBe(empty);
  });

  test('T finds the nearest boundary', () => {
    expect(nearestBoundary(t, 0)).toBe(0);
    expect(nearestBoundary(t, 24)).toBe(0);
    expect(nearestBoundary(t, 25)).toBe(0);
    expect(nearestBoundary(t, 26)).toBe(1);
    expect(nearestBoundary(t, 99)).toBe(3);
    expect(nearestBoundary(empty, 50)).toBe(-1);
  });

  test('operations reject positions outside the recording', () => {
    expect(() => keep(empty, FRAMES)).toThrow(RangeError);
    expect(() => keep(empty, -1)).toThrow(RangeError);
    expect(() => moveBoundary(t, 9, 5, 'drag')).toThrow(RangeError);
    expect(() => emptyTimeline(0)).toThrow(RangeError);
  });
});

describe('properties of every reachable timeline', () => {
  const arb = fc.integer({ min: 1, max: 40 }).chain((n) => timelineArb(n));
  const anyFrame = (t: Timeline) => fc.integer({ min: 0, max: t.frameCount - 1 });

  /** The frames from `frame` up to (not including) the next boundary after it. */
  const runFrom = (t: Timeline, frame: number) => {
    const next = t.boundaries.find((b) => b.frame > frame)?.frame ?? t.frameCount;
    return [frame, next] as const;
  };

  test('boundaries stay strictly increasing and inside the recording', () => {
    fc.assert(
      fc.property(arb, (t) => {
        t.boundaries.forEach((b, i) => {
          expect(Number.isInteger(b.frame) && b.frame >= 0 && b.frame < t.frameCount).toBe(true);
          if (i > 0) expect(b.frame).toBeGreaterThan(t.boundaries[i - 1]!.frame);
        });
      }),
    );
  });

  test('stateAt and segments agree with a frame-by-frame reading', () => {
    fc.assert(
      fc.property(arb, (t) => {
        const states = frameStates(t);
        states.forEach((state, frame) => {
          expect(stateAt(t, frame)).toBe(state);
        });
        const runs = segments(t);
        expect(runs.flatMap((s) => new Array(s.end - s.start).fill(s.state))).toEqual(states);
        runs.forEach((s, i) => {
          expect(s.end).toBeGreaterThan(s.start);
          if (i > 0) expect(s.state).not.toBe(runs[i - 1]!.state);
        });
      }),
    );
  });

  test('S/D is idempotent, a no-op when already in that state, and local', () => {
    const input = arb.chain((t) =>
      fc.tuple(fc.constant(t), anyFrame(t), fc.constantFrom('keep' as const, 'cut' as const)),
    );
    fc.assert(
      fc.property(input, ([t, frame, state]) => {
        const once = setStateFrom(t, frame, state, 'live');
        expect(setStateFrom(once, frame, state, 'live')).toBe(once);
        if (stateAt(t, frame) === state) expect(once).toBe(t);
        const [from, to] = runFrom(t, frame);
        const before = frameStates(t);
        frameStates(once).forEach((s, f) => {
          expect(s).toBe(f >= from && f < to ? state : before[f]);
        });
      }),
    );
  });

  test('moving a boundary changes only the frames it passes over', () => {
    const input = arb
      .filter((t) => t.boundaries.length > 0)
      .chain((t) =>
        fc.tuple(fc.constant(t), fc.nat({ max: t.boundaries.length - 1 }), anyFrame(t)),
      );
    fc.assert(
      fc.property(input, ([t, index, frame]) => {
        const moved = moveBoundary(t, index, frame, 'drag');
        const from = t.boundaries[index]!.frame;
        const to = moved.boundaries[index]!.frame;
        const before = frameStates(t);
        const after = frameStates(moved);
        before.forEach((s, f) => {
          if (f < Math.min(from, to) || f >= Math.max(from, to)) expect(after[f]).toBe(s);
        });
      }),
    );
  });

  test('X flips exactly the run under the playhead', () => {
    const input = arb.chain((t) => fc.tuple(fc.constant(t), anyFrame(t)));
    fc.assert(
      fc.property(input, ([t, frame]) => {
        const start = t.boundaries[boundaryIndexAt(t, frame)]?.frame;
        const [from, to] =
          start === undefined ? [0, t.boundaries[0]?.frame ?? t.frameCount] : runFrom(t, start);
        const before = frameStates(t);
        frameStates(flipSegmentAt(t, frame)).forEach((s, f) => {
          const flipped = before[f] === 'keep' ? 'cut' : 'keep';
          expect(s).toBe(f >= from && f < to ? flipped : before[f]);
        });
      }),
    );
  });

  test('deleting a boundary extends the previous run; deleting a through boundary changes nothing', () => {
    const input = arb
      .filter((t) => t.boundaries.length > 0)
      .chain((t) => fc.tuple(fc.constant(t), fc.nat({ max: t.boundaries.length - 1 })));
    fc.assert(
      fc.property(input, ([t, index]) => {
        const deleted = deleteBoundary(t, index);
        const [from, to] = runFrom(t, t.boundaries[index]!.frame);
        const previous = from === 0 ? 'cut' : stateAt(t, from - 1);
        const before = frameStates(t);
        frameStates(deleted).forEach((s, f) => {
          expect(s).toBe(f >= from && f < to ? previous : before[f]);
        });
        if (isThrough(t, index)) expect(segments(deleted)).toEqual(segments(t));
      }),
    );
  });

  test('confirming a boundary changes only its check flag', () => {
    const input = arb
      .filter((t) => t.boundaries.length > 0)
      .chain((t) => fc.tuple(fc.constant(t), fc.nat({ max: t.boundaries.length - 1 })));
    fc.assert(
      fc.property(input, ([t, index]) => {
        markChecked(t, index).boundaries.forEach((b, i) => {
          const original = t.boundaries[i]!;
          expect(b).toEqual(i === index ? { ...original, checked: true } : original);
        });
      }),
    );
  });
});
