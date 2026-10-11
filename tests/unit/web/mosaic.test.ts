import { describe, expect, test } from 'vitest';
import { mosaic } from '../../../src/web/mosaic.ts';

const FOUR_THREE = { main: 4 / 3, side: 4 / 3 };

describe('camera mosaic', () => {
  test('a wide stage: the tiles are as tall as the stage, the small ones stacked to the same height', () => {
    const m = mosaic(1400, 600, FOUR_THREE, 2, 8);
    expect(m.mainHeight).toBe(600);
    expect(m.mainWidth).toBe(800);
    expect(m.sideHeight * 2 + 8).toBeLessThanOrEqual(600);
    expect(m.sideHeight).toBe(296);
    expect(m.mainWidth + 8 + m.sideWidth).toBeLessThanOrEqual(1400);
  });

  test('a narrow stage: the width decides, and everything still fits', () => {
    for (const [width, height] of [
      [700, 900],
      [500, 500],
      [1100, 560],
    ] as const) {
      const m = mosaic(width, height, FOUR_THREE, 2, 8);
      expect(m.mainWidth + 8 + m.sideWidth).toBeLessThanOrEqual(width);
      expect(m.mainHeight).toBeLessThanOrEqual(height);
      expect(m.sideHeight * 2 + 8).toBeLessThanOrEqual(m.mainHeight);
      // Nothing is left over on both sides: one of the two limits is reached (to the pixel).
      expect(width - (m.mainWidth + 8 + m.sideWidth) <= 3 || height - m.mainHeight <= 1).toBe(true);
    }
  });

  test('every tile keeps its video shape', () => {
    const m = mosaic(1200, 700, { main: 16 / 9, side: 4 / 3 }, 2, 8);
    expect(m.mainWidth / m.mainHeight).toBeCloseTo(16 / 9, 1);
    expect(m.sideWidth / m.sideHeight).toBeCloseTo(4 / 3, 1);
  });

  test('portrait small cameras get portrait tiles', () => {
    const m = mosaic(1400, 600, { main: 4 / 3, side: 9 / 16 }, 2, 8);
    expect(m.sideWidth / m.sideHeight).toBeCloseTo(9 / 16, 1);
  });

  test('one camera alone fills what it can; a tiny stage gives empty tiles, never negative ones', () => {
    expect(mosaic(1000, 600, FOUR_THREE, 0, 8)).toEqual({
      mainWidth: 800,
      mainHeight: 600,
      sideWidth: 0,
      sideHeight: 0,
    });
    const tiny = mosaic(4, 4, FOUR_THREE, 2, 8);
    expect(Math.min(...Object.values(tiny))).toBe(0);
  });
});
