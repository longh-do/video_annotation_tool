/** Synthetic recordings for tests: real file formats, no real data. */
import fc from 'fast-check';
import { type FrameMap, parseFramesCsv } from '../../src/core/frame-map.ts';
import {
  deleteBoundary,
  emptyTimeline,
  markChecked,
  moveBoundary,
  ORIGINS,
  type Origin,
  type State,
  setRange,
  setStateFrom,
  type Timeline,
} from '../../src/core/timeline.ts';

export interface SyntheticPart {
  readonly file: string;
  /** Source timestamp of the part's first frame. */
  readonly startNs: bigint;
  /** Microseconds between consecutive frames (one fewer than the frames). */
  readonly gapsUs: readonly number[];
}

/**
 * A frames CSV in the real format. Each part's video clock starts at 0. Source time follows the
 * video clock plus a sub-microsecond remainder, as in real exports.
 */
export function framesCsv(parts: readonly SyntheticPart[]): string {
  const lines = ['video_file,frame_index,video_time_s,source_ts_ns,source_frame_id'];
  let index = 0;
  for (const part of parts) {
    let us = 0;
    for (let k = 0; k <= part.gapsUs.length; k++) {
      const ns = part.startNs + BigInt(us) * 1000n + BigInt((index * 7919) % 1000);
      lines.push(`${part.file},${index},${seconds(us)},${ns},${1000 + index}`);
      us += part.gapsUs[k] ?? 0;
      index++;
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Integer microseconds as the CSV writes them: seconds with six decimals. */
export function seconds(us: number): string {
  return `${Math.floor(us / 1e6)}.${String(us % 1e6).padStart(6, '0')}`;
}

export function frameMap(startNs: bigint, gapsUs: readonly number[]): FrameMap {
  return parseFramesCsv(framesCsv([{ file: 'head-0000.mp4', startNs, gapsUs }]));
}

/** Host-uptime clocks like today's data (~3e12) and epoch clocks that a double can't hold. */
export const startNsArb = fc.oneof(
  fc.bigInt({ min: 0n, max: 10n ** 13n }),
  fc.bigInt({ min: 1_700_000_000_000_000_000n, max: 1_900_000_000_000_000_000n }),
);

/** Variable frame rate like the real videos: 4.7 ms to 102 ms between frames. */
export const gapsUsArb = (maxFrames: number) =>
  fc.array(fc.integer({ min: 4_700, max: 102_000 }), { maxLength: maxFrames - 1 });

/**
 * Frame maps of one to three video parts. Each part restarts its video clock at 0; source time
 * jumps over a gap of up to 5 s between parts.
 */
export const frameMapArb = (maxFrames = 60) =>
  fc
    .tuple(
      startNsArb,
      fc.array(
        fc.tuple(gapsUsArb(Math.ceil(maxFrames / 3)), fc.bigInt({ min: 1n, max: 5n * 10n ** 9n })),
        {
          minLength: 1,
          maxLength: 3,
        },
      ),
    )
    .map(([startNs, specs]) => {
      let next = startNs;
      const parts = specs.map(([gapsUs, sourceGapNs], i) => {
        const part = { file: `head-000${i}.mp4`, startNs: next, gapsUs };
        // Past this part's last frame (sub-microsecond remainders are under 1000 ns).
        next += BigInt(gapsUs.reduce((a, b) => a + b, 0)) * 1000n + 1000n + sourceGapNs;
        return part;
      });
      return parseFramesCsv(framesCsv(parts));
    });

/** One user edit; positions are taken modulo the timeline's size so they fit any timeline. */
export type Edit =
  | { readonly kind: 'set'; readonly at: number; readonly state: State; readonly origin: Origin }
  | { readonly kind: 'move'; readonly which: number; readonly to: number; readonly origin: Origin }
  | { readonly kind: 'range'; readonly at: number; readonly length: number; readonly state: State }
  | { readonly kind: 'delete'; readonly which: number }
  | { readonly kind: 'check'; readonly which: number };

const position = fc.nat();
const origin = fc.constantFrom(...ORIGINS);

export const editArb: fc.Arbitrary<Edit> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('set' as const),
      at: position,
      state: fc.constantFrom('keep' as const, 'cut' as const),
      origin,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('move' as const),
      which: position,
      to: position,
      origin,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('range' as const),
      at: position,
      length: position,
      state: fc.constantFrom('keep' as const, 'cut' as const),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), which: position }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('check' as const), which: position }) },
);

export function applyEdit(t: Timeline, edit: Edit): Timeline {
  const frame = (n: number) => n % t.frameCount;
  const index = (n: number) => n % t.boundaries.length;
  const none = t.boundaries.length === 0;
  switch (edit.kind) {
    case 'set':
      return setStateFrom(t, frame(edit.at), edit.state, edit.origin);
    case 'move':
      return none ? t : moveBoundary(t, index(edit.which), frame(edit.to), edit.origin);
    case 'range': {
      const from = frame(edit.at);
      return setRange(t, from, from + 1 + (edit.length % (t.frameCount - from)), edit.state);
    }
    case 'delete':
      return none ? t : deleteBoundary(t, index(edit.which));
    case 'check':
      return none ? t : markChecked(t, index(edit.which));
  }
}

/** Timelines reachable by editing: what the app can actually produce. */
export const timelineArb = (frameCount: number, maxEdits = 40) =>
  fc
    .array(editArb, { maxLength: maxEdits, size: 'max' })
    .map((edits) => edits.reduce(applyEdit, emptyTimeline(frameCount)));

/** A frame map together with a timeline over its frames. */
export const recordingArb = (maxFrames = 60) =>
  frameMapArb(maxFrames).chain((frames) =>
    timelineArb(frames.tsNs.length).map((timeline) => ({ frames, timeline })),
  );

/** Reference semantics, independent of the binary searches under test: the state of each frame. */
export function frameStates(t: Timeline): State[] {
  const states = new Array<State>(t.frameCount).fill('cut');
  for (const b of t.boundaries) states.fill(b.state, b.frame);
  return states;
}
