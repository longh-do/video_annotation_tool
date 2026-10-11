import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  displayedFrame,
  frameCount,
  frameNs,
  nearestFrame,
  parseFramesCsv,
  positionAtNs,
  stopNs,
} from '../../src/core/frame-map.ts';
import { frameMapArb, framesCsv } from './synthetic.ts';

const HEADER = 'video_file,frame_index,video_time_s,source_ts_ns,source_frame_id';

// Three frames 40 ms and 4.7 ms apart (the real videos have a variable frame rate).
const csv = `${HEADER}
head-0000.mp4,0,0.000000,1000000000000,7
head-0000.mp4,1,0.040000,1000040000123,8
head-0000.mp4,2,0.044700,1000044700456,9
`;

// Two parts with a gap in source time; each part's video clock starts at 0.
const twoParts = parseFramesCsv(
  framesCsv([
    { file: 'head-0000.mp4', startNs: 1_000_000_000n, gapsUs: [33_000, 33_000] },
    { file: 'head-0001.mp4', startNs: 9_000_000_000n, gapsUs: [40_000] },
  ]),
);

describe('parseFramesCsv', () => {
  test('reads both clocks exactly', () => {
    const map = parseFramesCsv(csv);
    expect([...map.ptsUs]).toEqual([0, 40_000, 44_700]);
    expect([...map.tsNs]).toEqual([1_000_000_000_000n, 1_000_040_000_123n, 1_000_044_700_456n]);
    expect(map.parts).toEqual([{ file: 'head-0000.mp4', firstFrame: 0, frameCount: 3 }]);
  });

  test('accepts CRLF line endings, a byte-order mark and fewer decimals', () => {
    const map = parseFramesCsv(`﻿${HEADER}\r\nhead-0000.mp4,0,0,5,1\r\nhead-0000.mp4,1,0.5,9,2\r\n`);
    expect([...map.ptsUs]).toEqual([0, 500_000]);
  });

  test('keeps epoch-sized timestamps exact', () => {
    const map = parseFramesCsv(`${HEADER}\nhead-0000.mp4,0,0.000000,1760000405418849217,1\n`);
    expect(String(map.tsNs[0])).toBe('1760000405418849217');
  });

  test('splits a camera into its video parts', () => {
    expect(twoParts.parts).toEqual([
      { file: 'head-0000.mp4', firstFrame: 0, frameCount: 3 },
      { file: 'head-0001.mp4', firstFrame: 3, frameCount: 2 },
    ]);
  });

  test.each([
    [
      'a missing column',
      'video_file,video_time_s\nhead-0000.mp4,0.0\n',
      /missing column "source_ts_ns"/,
    ],
    ['no rows', `${HEADER}\n`, /no frames/],
    ['a short row', `${HEADER}\nhead-0000.mp4,0,0.0,5\n`, /line 2: expected 5 columns/],
    ['7 decimals', `${HEADER}\nhead-0000.mp4,0,0.0000001,5,1\n`, /line 2: video_time_s/],
    ['a negative timestamp', `${HEADER}\nhead-0000.mp4,0,0.0,-5,1\n`, /line 2: source_ts_ns/],
    [
      'a 65-bit timestamp',
      `${HEADER}\nhead-0000.mp4,0,0.0,9223372036854775808,1\n`,
      /line 2: source_ts_ns/,
    ],
    [
      'source time going backwards',
      `${HEADER}\nhead-0000.mp4,0,0.0,9,1\nhead-0000.mp4,1,0.1,8,2\n`,
      /line 3: source_ts_ns must strictly increase/,
    ],
    [
      'video time going backwards',
      `${HEADER}\nhead-0000.mp4,0,0.2,8,1\nhead-0000.mp4,1,0.1,9,2\n`,
      /line 3: video_time_s must increase/,
    ],
    [
      'interleaved parts',
      `${HEADER}\na.mp4,0,0.0,1,1\nb.mp4,1,0.0,2,2\na.mp4,2,0.1,3,3\n`,
      /line 4: a.mp4 rows must be contiguous/,
    ],
  ])('rejects %s', (_, text, message) => {
    expect(() => parseFramesCsv(text)).toThrow(message);
  });
});

describe('displayedFrame', () => {
  const map = parseFramesCsv(csv);

  test('takes the last frame at or before the time, never the nearest', () => {
    expect(displayedFrame(map, 0, 0)).toBe(0);
    expect(displayedFrame(map, 0, 0.039999)).toBe(0);
    expect(displayedFrame(map, 0, 0.04)).toBe(1);
    expect(displayedFrame(map, 0, 0.044699)).toBe(1);
    expect(displayedFrame(map, 0, 99)).toBe(2);
    expect(displayedFrame(map, 0, -0.1)).toBe(-1);
  });

  test("survives a frame's exact time that is just below it in floating point", () => {
    // 2.076348 * 1e6 === 2076347.9999999998: without rounding, this lands on the previous frame.
    const tricky = parseFramesCsv(`${HEADER}\nh.mp4,0,2.076300,5,1\nh.mp4,1,2.076348,9,2\n`);
    expect(displayedFrame(tricky, 0, 2.076348)).toBe(1);
  });

  test("uses each part's own clock", () => {
    expect(displayedFrame(twoParts, 0, 1)).toBe(2);
    expect(displayedFrame(twoParts, 1, 0)).toBe(3);
    expect(displayedFrame(twoParts, 1, 0.039999)).toBe(3);
    expect(displayedFrame(twoParts, 1, 0.04)).toBe(4);
  });
});

describe('interval timestamps', () => {
  const map = parseFramesCsv(csv);

  test('an interval starts at its first frame and stops at the frame it excludes', () => {
    expect(frameNs(map, 1)).toBe(1_000_040_000_123n);
    expect(stopNs(map, 1)).toBe(1_000_040_000_123n);
    expect(() => frameNs(map, 3)).toThrow(RangeError);
  });

  test('a stop after the last frame of a video part is that frame + 1 ns, so the gap is cut', () => {
    expect(frameCount(map)).toBe(3);
    expect(stopNs(map, 3)).toBe(1_000_044_700_457n);
    expect(stopNs(twoParts, 3)).toBe(twoParts.tsNs[2]! + 1n);
    expect(stopNs(twoParts, 5)).toBe(twoParts.tsNs[4]! + 1n);
  });

  test('positionAtNs reads either kind back, and snaps anything else to the frame on screen', () => {
    expect(positionAtNs(map, 1_000_040_000_123n)).toBe(1);
    expect(positionAtNs(map, 1_000_040_000_124n)).toBe(1);
    expect(positionAtNs(map, 1_000_040_000_122n)).toBe(0);
    expect(positionAtNs(map, 0n)).toBe(0);
    expect(positionAtNs(map, 1_000_044_700_457n)).toBe(3);
    expect(positionAtNs(map, 2_000_000_000_000n)).toBe(3);
    expect(positionAtNs(twoParts, twoParts.tsNs[2]! + 1n)).toBe(3);
    expect(positionAtNs(twoParts, twoParts.tsNs[2]! + 2n)).toBe(2);
  });
});

describe('nearestFrame', () => {
  const map = parseFramesCsv(csv);

  test('picks the closest frame, or none beyond a maximum distance', () => {
    expect(nearestFrame(map, 1_000_020_000_061n)).toBe(0);
    expect(nearestFrame(map, 1_000_020_000_062n)).toBe(1);
    expect(nearestFrame(map, 0n)).toBe(0);
    expect(nearestFrame(map, 2_000_000_000_000n)).toBe(2);
    expect(nearestFrame(map, 2_000_000_000_000n, 1_000_000n)).toBe(-1);
  });

  test('breaks an exact tie toward the earlier frame', () => {
    const even = parseFramesCsv(`${HEADER}\nh.mp4,0,0.0,100,1\nh.mp4,1,0.1,200,2\n`);
    expect(nearestFrame(even, 150n)).toBe(0);
  });
});

describe('properties on variable-frame-rate maps with one to three parts', () => {
  test('every frame is found from its own presentation time and from the seek target', () => {
    fc.assert(
      fc.property(frameMapArb(200), (map) => {
        map.parts.forEach((part, p) => {
          const end = part.firstFrame + part.frameCount;
          for (let k = part.firstFrame; k < end; k++) {
            const pts = map.ptsUs[k]!;
            const gap = k + 1 < end ? map.ptsUs[k + 1]! - pts : 33_333;
            // The player seeks to PTS + min(1 ms, gap / 2) to dodge engine rounding.
            expect(displayedFrame(map, p, pts / 1e6)).toBe(k);
            expect(displayedFrame(map, p, (pts + Math.min(1000, Math.floor(gap / 2))) / 1e6)).toBe(
              k,
            );
          }
          expect(displayedFrame(map, p, -0.001)).toBe(-1);
        });
      }),
    );
  });

  test('start and stop timestamps read back to their own position', () => {
    fc.assert(
      fc.property(frameMapArb(200), (map) => {
        map.tsNs.forEach((ns, k) => {
          expect(positionAtNs(map, ns)).toBe(k);
          expect(nearestFrame(map, ns)).toBe(k);
          expect(frameNs(map, k)).toBe(ns);
        });
        for (let position = 1; position <= frameCount(map); position++) {
          expect(positionAtNs(map, stopNs(map, position))).toBe(position);
        }
      }),
    );
  });
});
