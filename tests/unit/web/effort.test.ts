import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EffortClock } from '../../../src/web/effort.ts';

describe('effort', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['performance'] }));
  afterEach(() => vi.useRealTimers());

  test('active while playing or within 30 s of a key or click; wall time while visible', () => {
    const clock = new EffortClock({ activeMs: 1000, wallMs: 2000 }, true);
    vi.advanceTimersByTime(10_000); // reading the guideline: still active
    expect(clock.read()).toEqual({ activeMs: 11_000, wallMs: 12_000 });
    vi.advanceTimersByTime(40_000); // a break with the tab open: active for 20 s more, then idle
    expect(clock.read()).toEqual({ activeMs: 31_000, wallMs: 52_000 });
    clock.setPlaying(true);
    vi.advanceTimersByTime(5000);
    clock.setPlaying(false);
    expect(clock.read()).toEqual({ activeMs: 36_000, wallMs: 57_000 });
  });

  test('idle time before a key press is not active, however long it was', () => {
    const clock = new EffortClock({ activeMs: 0, wallMs: 0 }, true);
    vi.advanceTimersByTime(45_000);
    clock.noteInput();
    vi.advanceTimersByTime(1000);
    expect(clock.read()).toEqual({ activeMs: 31_000, wallMs: 46_000 });
  });

  test('time with the page hidden counts nothing, even while playing', () => {
    const clock = new EffortClock({ activeMs: 0, wallMs: 0 }, true);
    clock.setPlaying(true);
    vi.advanceTimersByTime(2000);
    clock.setVisible(false);
    vi.advanceTimersByTime(60_000);
    clock.setVisible(true);
    vi.advanceTimersByTime(3000);
    expect(clock.read()).toEqual({ activeMs: 5000, wallMs: 5000 });
  });
});
