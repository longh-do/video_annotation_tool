import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EffortClock } from '../../../src/web/effort.ts';

describe('effort', () => {
  let visibility: 'visible' | 'hidden' = 'visible';
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
    visibility = 'visible';
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibility;
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('active while playing or within 30 s of a key or click; wall time while visible', () => {
    let playing = false;
    const clock = new EffortClock({ activeMs: 1000, wallMs: 2000 }, () => playing);
    vi.advanceTimersByTime(10_000); // reading the guideline: still active
    expect(clock.read()).toEqual({ activeMs: 11_000, wallMs: 12_000 });
    vi.advanceTimersByTime(40_000); // a break with the tab open
    expect(clock.read()).toEqual({ activeMs: 11_000, wallMs: 52_000 });
    playing = true;
    vi.advanceTimersByTime(5000);
    expect(clock.read()).toEqual({ activeMs: 16_000, wallMs: 57_000 });
    playing = false;
    clock.noteInput();
    vi.advanceTimersByTime(3000);
    expect(clock.read()).toEqual({ activeMs: 19_000, wallMs: 60_000 });
  });

  test('a hidden page counts nothing', () => {
    const clock = new EffortClock({ activeMs: 0, wallMs: 0 }, () => true);
    visibility = 'hidden';
    vi.advanceTimersByTime(60_000);
    expect(clock.read()).toEqual({ activeMs: 0, wallMs: 0 });
  });
});
