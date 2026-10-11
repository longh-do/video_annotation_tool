import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  clearAll,
  deleteBoundary,
  emptyTimeline,
  keepSegments,
  markChecked,
  moveBoundary,
  segments,
  setRange,
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

  test('a mark on an existing boundary takes it back', () => {
    // S at 10, D at 40, then S at 40: the keep from 10 goes on, and nothing is left at 40.
    const t = keep(cut(keep(empty, 10), 40), 40);
    expect(frames(t)).toEqual([10]);
    expect(keepSegments(t)).toEqual([{ start: 10, end: FRAMES, state: 'keep' }]);
  });

  test('a boundary that changes nothing is dropped, so the marks after it work as pressed', () => {
    // S at 10, then D at 10 to take it back: nothing is left behind to cut the next interval short.
    const t = cut(keep(cut(keep(empty, 10), 10), 5), 40);
    expect(keepSegments(t)).toEqual([{ start: 5, end: 40, state: 'keep' }]);
    expect(frames(t)).toEqual([5, 40]);
    // An early D makes the later D redundant: it goes, and undo is what brings it back.
    expect(frames(cut(cut(keep(empty, 10), 40), 25))).toEqual([10, 25]);
    // Deleting a boundary drops the one after it if that one now changes nothing.
    const two = cut(keep(cut(keep(empty, 10), 20), 30), 40);
    expect(frames(deleteBoundary(two, 1))).toEqual([10, 40]);
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

  test('moving a live mark puts it where the annotator chose, so it is exact', () => {
    const live = setStateFrom(empty, 10, 'keep', 'live');
    expect(moveBoundary(live, 0, 8, 'nudge').boundaries[0]).toMatchObject({ checked: true });
    expect(moveBoundary(live, 0, 12, 'drag').boundaries[0]).toMatchObject({ checked: true });
  });

  test('a move that lands where the mark is changes nothing, and does not confirm it', () => {
    const live = setStateFrom(empty, 10, 'keep', 'live');
    expect(moveBoundary(live, 0, 10, 'drag')).toBe(live);
    expect(
      moveBoundary(setStateFrom(live, 11, 'cut', 'live'), 1, 10, 'nudge').boundaries[1],
    ).toMatchObject({
      frame: 11,
      checked: false,
    });
  });

  test('deleting an interval removes both of its boundaries', () => {
    const deleted = setRange(t, 60, 80, 'cut');
    expect(frames(deleted)).toEqual([10, 40]);
    expect(deleted.boundaries).toEqual(t.boundaries.slice(0, 2));
  });

  test('keeping the gap between two intervals merges them', () => {
    expect(frames(setRange(t, 40, 60, 'keep'))).toEqual([10, 80]);
  });

  test('keeping the stretch before the first interval keeps from frame 0', () => {
    const kept = setRange(t, 0, 10, 'keep');
    expect(keepSegments(kept)).toEqual([
      { start: 0, end: 40, state: 'keep' },
      { start: 60, end: 80, state: 'keep' },
    ]);
    expect(kept.boundaries[0]).toEqual({
      frame: 0,
      state: 'keep',
      origin: 'placed',
      checked: true,
    });
  });

  test('keeping the stretch after the last interval keeps to END', () => {
    expect(keepSegments(setRange(t, 80, FRAMES, 'keep')).at(-1)).toEqual({
      start: 60,
      end: FRAMES,
      state: 'keep',
    });
  });

  test('a range inside an interval splits it, with new checked boundaries', () => {
    const split = setRange(t, 20, 30, 'cut');
    expect(frames(split)).toEqual([10, 20, 30, 40, 60, 80]);
    expect(split.boundaries[2]).toEqual({
      frame: 30,
      state: 'keep',
      origin: 'placed',
      checked: true,
    });
  });

  test('a range that changes nothing returns the same timeline', () => {
    expect(setRange(t, 20, 30, 'keep')).toBe(t);
    expect(setRange(empty, 0, FRAMES, 'cut')).toBe(empty);
    expect(() => setRange(t, 20, 20, 'cut')).toThrow(RangeError);
    expect(() => setRange(t, 20, FRAMES + 1, 'cut')).toThrow(RangeError);
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

  test('every boundary changes the state: none repeats the state before it', () => {
    fc.assert(
      fc.property(arb, (t) => {
        t.boundaries.forEach((b, i) => {
          expect(b.state).not.toBe(t.boundaries[i - 1]?.state ?? 'cut');
        });
      }),
    );
  });

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

  test('setting a range changes exactly its frames and leaves no boundary inside it', () => {
    const input = arb.chain((t) =>
      fc.tuple(
        fc.constant(t),
        anyFrame(t),
        fc.integer({ min: 1, max: t.frameCount }),
        fc.constantFrom('keep' as const, 'cut' as const),
      ),
    );
    fc.assert(
      fc.property(input, ([t, a, b, state]) => {
        const [from, to] = a < b ? [a, b] : [b - 1, a + 1];
        const set = setRange(t, from, to, state);
        const before = frameStates(t);
        frameStates(set).forEach((s, f) => {
          expect(s).toBe(f >= from && f < to ? state : before[f]);
        });
        expect(set.boundaries.some((b) => b.frame > from && b.frame < to)).toBe(false);
        set.boundaries.forEach((b, i) => {
          if (i > 0) expect(b.frame).toBeGreaterThan(set.boundaries[i - 1]!.frame);
        });
      }),
    );
  });

  test('deleting a boundary extends the previous run', () => {
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
