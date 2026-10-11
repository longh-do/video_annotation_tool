import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  keepIntervals,
  type Reference,
  type SidecarDraft,
  sidecarBoundaries,
  timelineFromIntervals,
  timelineFromSidecar,
  validateAnnotationFile,
  validateSidecarDraft,
} from '../../src/core/annotation.ts';
import { parseFramesCsv } from '../../src/core/frame-map.ts';
import {
  emptyTimeline,
  keepSegments,
  setStateFrom,
  type Timeline,
} from '../../src/core/timeline.ts';
import { recordingArb } from './synthetic.ts';

const HEADER = 'video_file,frame_index,video_time_s,source_ts_ns,source_frame_id';
const frames = parseFramesCsv(`${HEADER}
head-0000.mp4,0,0.000000,3000000000000,1
head-0000.mp4,1,0.041579,3000041579149,2
head-0000.mp4,2,0.071983,3000071983644,3
head-0000.mp4,3,0.111987,3000111987068,4
head-0000.mp4,4,0.150000,3000150000500,5
`);
const reference: Reference = {
  recordingId: '2030-01-01--00-00-00',
  referenceVideo: 'videos/head-0000.mp4',
  frames,
};

const keepFrom = (t: Timeline, frame: number) => setStateFrom(t, frame, 'keep', 'paused');
const cutFrom = (t: Timeline, frame: number) => setStateFrom(t, frame, 'cut', 'paused');

function file(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recording_id: reference.recordingId,
    reference_video: reference.referenceVideo,
    status: 'complete',
    keep_intervals: [{ start_ns: '3000041579149', end_ns: '3000111987068' }],
    notes: '',
    ...overrides,
  };
}

describe('keep intervals', () => {
  test('use the timestamp of the frame shown at Start and at Stop: [start, stop)', () => {
    const t = cutFrom(keepFrom(emptyTimeline(5), 1), 3);
    expect(keepIntervals(t, frames)).toEqual([
      { start_ns: '3000041579149', end_ns: '3000111987068' },
    ]);
  });

  test('a keep that runs to the end stops one nanosecond after the last frame', () => {
    expect(keepIntervals(keepFrom(emptyTimeline(5), 4), frames)).toEqual([
      { start_ns: '3000150000500', end_ns: '3000150000501' },
    ]);
  });

  test('stay exact for epoch-sized clocks', () => {
    const epoch = parseFramesCsv(`${HEADER}
head-0000.mp4,0,0.000000,1760000405418849217,1
head-0000.mp4,1,0.033333,1760000405452182301,2
`);
    expect(keepIntervals(keepFrom(emptyTimeline(2), 0), epoch)).toEqual([
      { start_ns: '1760000405418849217', end_ns: '1760000405452182302' },
    ]);
  });

  test('a keep that ends with a video part stops one nanosecond after its last frame', () => {
    const parts = parseFramesCsv(`${HEADER}
head-0000.mp4,0,0.000000,1000,1
head-0000.mp4,1,0.033000,2000,2
head-0001.mp4,2,0.000000,9000,3
head-0001.mp4,3,0.033000,9900,4
`);
    // Keep frames 0–1 (all of part 0) and frame 3: the first interval must not keep the gap.
    let t = setStateFrom(emptyTimeline(4), 0, 'keep', 'paused');
    t = setStateFrom(t, 2, 'cut', 'paused');
    t = setStateFrom(t, 3, 'keep', 'paused');
    expect(keepIntervals(t, parts)).toEqual([
      { start_ns: '1000', end_ns: '2001' },
      { start_ns: '9900', end_ns: '9901' },
    ]);
    const reference2 = { ...reference, frames: parts };
    const valid = file({ keep_intervals: keepIntervals(t, parts) });
    expect(validateAnnotationFile(valid, reference2)).toEqual([]);
    // Stopping on the next part's first frame would keep the gap between parts.
    const gap = file({ keep_intervals: [{ start_ns: '1000', end_ns: '9000' }] });
    expect(validateAnnotationFile(gap, reference2).join()).toMatch(/end of a video/);
  });

  test('reject a timeline built for different frames', () => {
    expect(() => keepIntervals(emptyTimeline(4), frames)).toThrow(RangeError);
  });
});

describe('validateAnnotationFile', () => {
  test('accepts a valid file, including "complete" with no intervals', () => {
    expect(validateAnnotationFile(file(), reference)).toEqual([]);
    expect(validateAnnotationFile(file({ keep_intervals: [] }), reference)).toEqual([]);
    expect(
      validateAnnotationFile(
        file({ keep_intervals: [{ start_ns: '3000150000500', end_ns: '3000150000501' }] }),
        reference,
      ),
    ).toEqual([]);
  });

  test('accepts intervals that touch', () => {
    const touching = file({
      keep_intervals: [
        { start_ns: '3000000000000', end_ns: '3000071983644' },
        { start_ns: '3000071983644', end_ns: '3000111987068' },
      ],
    });
    expect(validateAnnotationFile(touching, reference)).toEqual([]);
  });

  test.each([
    ['not an object', [], /JSON object/],
    ['an extra field', file({ annotator: 'x' }), /unexpected fields: annotator/],
    ['another recording', file({ recording_id: 'other' }), /recording_id/],
    ['another video', file({ reference_video: 'videos/left-0000.mp4' }), /reference_video/],
    ['an unknown status', file({ status: 'done' }), /status must be one of/],
    ['numeric notes', file({ notes: 1 }), /notes must be a string/],
    [
      'needs_review without a note',
      file({ status: 'needs_review', notes: ' ' }),
      /requires a note/,
    ],
    ['intervals that are not a list', file({ keep_intervals: {} }), /must be an array/],
    [
      'numbers instead of strings',
      file({ keep_intervals: [{ start_ns: 3000041579149, end_ns: 3000111987068 }] }),
      /decimal-string timestamps/,
    ],
    [
      'an extra key in an interval',
      file({ keep_intervals: [{ start_ns: '3000041579149', end_ns: '3000111987068', x: 1 }] }),
      /decimal-string timestamps/,
    ],
    [
      'an empty interval',
      file({ keep_intervals: [{ start_ns: '3000041579149', end_ns: '3000041579149' }] }),
      /start_ns must be before end_ns/,
    ],
    [
      'overlapping intervals',
      file({
        keep_intervals: [
          { start_ns: '3000000000000', end_ns: '3000071983644' },
          { start_ns: '3000041579149', end_ns: '3000111987068' },
        ],
      }),
      /must start after the previous interval ends/,
    ],
    [
      'a boundary between frames',
      file({ keep_intervals: [{ start_ns: '3000041579150', end_ns: '3000111987068' }] }),
      /start_ns is not the timestamp of a reference frame/,
    ],
    [
      'a stop past END',
      file({ keep_intervals: [{ start_ns: '3000041579149', end_ns: '3000150000502' }] }),
      /end_ns is neither a reference frame's timestamp nor the end of a video/,
    ],
  ])('rejects %s', (_, value, message) => {
    expect(validateAnnotationFile(value, reference).join('\n')).toMatch(message);
  });
});

describe('restoring a timeline', () => {
  test('from keep intervals alone keeps the same output', () => {
    fc.assert(
      fc.property(recordingArb(), ({ frames, timeline }) => {
        const intervals = keepIntervals(timeline, frames);
        const restored = timelineFromIntervals(intervals, frames);
        expect(keepSegments(restored)).toEqual(keepSegments(timeline));
        expect(
          validateAnnotationFile(file({ keep_intervals: intervals }), { ...reference, frames }),
        ).toEqual([]);
      }),
    );
  });

  test('from the sidecar is exact, with every boundary, origin and check flag', () => {
    fc.assert(
      fc.property(recordingArb(), ({ frames, timeline }) => {
        expect(timelineFromSidecar(sidecarBoundaries(timeline, frames), frames)).toEqual(timeline);
      }),
    );
  });
});

describe('validateSidecarDraft', () => {
  let t = emptyTimeline(5);
  t = setStateFrom(t, 1, 'keep', 'live');
  t = setStateFrom(t, 3, 'cut', 'nudge');
  const draft: SidecarDraft = {
    schema_version: 1,
    tool_version: '0.1.0',
    guideline_version: 'sha256:abc',
    annotator_id: 'a1',
    frame_count: 5,
    boundaries: sidecarBoundaries(t, frames),
    review_reason: null,
    resume: { frame: 2, playback_rate: 2 },
    effort: { active_ms: 1000, wall_ms: 1500, edits: 2, undos: 0 },
  };

  test('accepts a consistent draft', () => {
    expect(validateSidecarDraft(draft, frames)).toEqual([]);
  });

  test.each([
    ['a different frame count', { frame_count: 6 }, /frame_count must be 5/],
    ['an unknown review reason', { review_reason: 'bored' }, /review_reason/],
    ['a missing playback rate', { resume: { frame: 0 } }, /resume/],
    ['negative effort', { effort: { active_ms: -1, wall_ms: 0, edits: 0, undos: 0 } }, /effort/],
    [
      'a boundary on the wrong timestamp',
      { boundaries: [{ ...draft.boundaries[0], ts_ns: '1' }] },
      /does not match the reference frames/,
    ],
    [
      'a boundary past the last frame',
      { boundaries: [{ ...draft.boundaries[0], frame: 999, ts_ns: 'undefined' }] },
      /does not match the reference frames/,
    ],
    [
      'an unchecked boundary that was not placed live',
      { boundaries: [{ ...draft.boundaries[0], origin: 'paused', checked: false }] },
      /only a live position can be unchecked/,
    ],
    [
      'two boundaries on one frame',
      { boundaries: [draft.boundaries[0], draft.boundaries[0]] },
      /out of order/,
    ],
    ['a resume frame past the end', { resume: { frame: 5, playback_rate: 2 } }, /resume/],
    [
      'boundaries out of order',
      { boundaries: [draft.boundaries[1], draft.boundaries[0]] },
      /out of order/,
    ],
  ])('rejects %s', (_, change, message) => {
    expect(validateSidecarDraft({ ...draft, ...change }, frames).join('\n')).toMatch(message);
  });
});
