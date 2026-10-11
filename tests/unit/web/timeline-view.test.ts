import { describe, expect, test } from 'vitest';
import {
  clamp,
  fit,
  minSpan,
  panned,
  revealed,
  TimelineView,
  zoomed,
} from '../../../src/web/timeline-view.ts';

const MINUTE = 60_000_000;

describe('timeline view', () => {
  test('starts out showing the whole recording', () => {
    expect(new TimelineView(MINUTE).view).toEqual({ startUs: 0, spanUs: MINUTE });
  });

  test('zooming keeps the anchor where it was on screen', () => {
    const view = zoomed(fit(MINUTE), MINUTE, 4, 30_000_000);
    expect(view.spanUs).toBe(15_000_000);
    // The anchor was in the middle and still is.
    expect(view.startUs + view.spanUs / 2).toBe(30_000_000);
    const again = zoomed(view, MINUTE, 2, view.startUs + view.spanUs / 4);
    expect((view.startUs + view.spanUs / 4 - again.startUs) / again.spanUs).toBeCloseTo(0.25);
  });

  test('zoom stops at one second and at the whole recording', () => {
    expect(zoomed(fit(MINUTE), MINUTE, 1000, 0).spanUs).toBe(1_000_000);
    expect(zoomed(fit(MINUTE), MINUTE, 0.5, 0)).toEqual(fit(MINUTE));
    // A recording shorter than a second can't zoom in at all.
    expect(minSpan(400_000)).toBe(400_000);
  });

  test('panning stops at either end', () => {
    const view = { startUs: 10_000_000, spanUs: 10_000_000 };
    expect(panned(view, MINUTE, -20_000_000).startUs).toBe(0);
    expect(panned(view, MINUTE, 90_000_000).startUs).toBe(50_000_000);
    expect(clamp({ startUs: -5, spanUs: 2 * MINUTE }, MINUTE)).toEqual(fit(MINUTE));
  });

  test('while playing, the view turns a page near the right edge', () => {
    const view = { startUs: 0, spanUs: 10_000_000 };
    expect(revealed(view, MINUTE, 9_000_000, true)).toBe(view);
    expect(revealed(view, MINUTE, 9_600_000, true)).toEqual({
      startUs: 9_100_000,
      spanUs: 10_000_000,
    });
  });

  test('when paused, a time off screen is centred and one on screen changes nothing', () => {
    const view = { startUs: 0, spanUs: 10_000_000 };
    expect(revealed(view, MINUTE, 10_000_000, false)).toBe(view);
    expect(revealed(view, MINUTE, 30_000_000, false)).toEqual({
      startUs: 25_000_000,
      spanUs: 10_000_000,
    });
    // Near the end the view stops at the end.
    expect(revealed(view, MINUTE, 59_000_000, false).startUs).toBe(50_000_000);
  });

  test('the store tells its subscribers about changes only', () => {
    const store = new TimelineView(MINUTE);
    let calls = 0;
    store.subscribe(() => calls++);
    store.fit();
    expect(calls).toBe(0);
    store.zoomTo(6_000_000, 30_000_000);
    expect(store.view.spanUs).toBe(6_000_000);
    store.reveal(31_000_000, false);
    expect(calls).toBe(1);
    store.pan(1_000_000);
    expect(calls).toBe(2);
  });
});
