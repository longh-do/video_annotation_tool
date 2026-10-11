/**
 * What gets saved for one recording.
 *
 * - The annotation file is exactly the data contract: recording id, reference video, status, keep
 *   intervals as nanosecond strings, and notes. Nothing else goes in it, so every consumer can
 *   rely on its shape.
 * - The sidecar holds what the tool needs to resume work and to measure it: every boundary with
 *   its origin and check state, the review reason, the resume point and effort counters.
 */
import { type FrameMap, frameCount, frameNs, positionAtNs, stopNs } from './frame-map.ts';
import { isNsString, parseNs } from './ns.ts';
import {
  type Boundary,
  emptyTimeline,
  keepSegments,
  ORIGINS,
  type Origin,
  STATES,
  type State,
  setStateFrom,
  type Timeline,
} from './timeline.ts';

export const STATUSES = ['not_reviewed', 'complete', 'needs_review'] as const;
export type Status = (typeof STATUSES)[number];

export const REVIEW_REASONS = [
  'unclear_boundary',
  'unfinished_task',
  'collection_problem',
  'other',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export interface KeepInterval {
  readonly start_ns: string;
  readonly end_ns: string;
}

export interface AnnotationFile {
  readonly recording_id: string;
  readonly reference_video: string;
  readonly status: Status;
  readonly keep_intervals: readonly KeepInterval[];
  readonly notes: string;
}

/** What a saved file must match: the recording and its reference video's frames. */
export interface Reference {
  readonly recordingId: string;
  readonly referenceVideo: string;
  readonly frames: FrameMap;
}

/**
 * Keep intervals [start, end) as source timestamps. An interval that keeps the last frame of a
 * video part ends one nanosecond after it.
 */
export function keepIntervals(t: Timeline, frames: FrameMap): KeepInterval[] {
  assertSameFrames(t, frames);
  return keepSegments(t).map((s) => ({
    start_ns: String(frameNs(frames, s.start)),
    end_ns: String(stopNs(frames, s.end)),
  }));
}

/** Everything that makes `value` break the contract; an empty list means it is valid. */
export function validateAnnotationFile(value: unknown, reference: Reference): string[] {
  if (!isRecord(value)) return ['the annotation must be a JSON object'];
  const problems: string[] = [];
  const expected = ['recording_id', 'reference_video', 'status', 'keep_intervals', 'notes'];
  const unexpected = Object.keys(value).filter((key) => !expected.includes(key));
  if (unexpected.length > 0) problems.push(`unexpected fields: ${unexpected.join(', ')}`);
  if (value.recording_id !== reference.recordingId) {
    problems.push(`recording_id must be "${reference.recordingId}"`);
  }
  if (value.reference_video !== reference.referenceVideo) {
    problems.push(`reference_video must be "${reference.referenceVideo}"`);
  }
  if (!isOneOf(STATUSES, value.status))
    problems.push(`status must be one of ${STATUSES.join(', ')}`);
  if (typeof value.notes !== 'string') problems.push('notes must be a string');
  else if (value.status === 'needs_review' && value.notes.trim() === '') {
    problems.push('needs_review requires a note');
  }
  if (!Array.isArray(value.keep_intervals)) problems.push('keep_intervals must be an array');
  else problems.push(...intervalProblems(value.keep_intervals, reference.frames));
  return problems;
}

function intervalProblems(intervals: readonly unknown[], frames: FrameMap): string[] {
  const problems: string[] = [];
  let previousEnd: bigint | null = null;
  intervals.forEach((interval, i) => {
    const at = `keep_intervals[${i}]`;
    if (
      !isRecord(interval) ||
      Object.keys(interval).length !== 2 ||
      !isNsString(interval.start_ns) ||
      !isNsString(interval.end_ns)
    ) {
      problems.push(`${at} must be {"start_ns", "end_ns"} with decimal-string timestamps`);
      return;
    }
    const start = parseNs(interval.start_ns);
    const end = parseNs(interval.end_ns);
    if (start >= end) problems.push(`${at}: start_ns must be before end_ns`);
    if (previousEnd !== null && start < previousEnd) {
      problems.push(`${at} must start after the previous interval ends`);
    }
    const startAt = positionAtNs(frames, start);
    if (startAt === frameCount(frames) || frameNs(frames, startAt) !== start) {
      problems.push(`${at}.start_ns is not the timestamp of a reference frame`);
    }
    const endAt = positionAtNs(frames, end);
    if (endAt === 0 || stopNs(frames, endAt) !== end) {
      problems.push(`${at}.end_ns is neither a reference frame's timestamp nor the end of a video`);
    }
    previousEnd = end;
  });
  return problems;
}

/**
 * Rebuilds a timeline from saved keep intervals, for files that have no sidecar. Positions are
 * treated as exact because they were saved that way.
 */
export function timelineFromIntervals(
  intervals: readonly KeepInterval[],
  frames: FrameMap,
): Timeline {
  let t = emptyTimeline(frameCount(frames));
  for (const interval of intervals) {
    const start = positionAtNs(frames, parseNs(interval.start_ns));
    const end = positionAtNs(frames, parseNs(interval.end_ns));
    if (start >= end) continue;
    t = setStateFrom(t, start, 'keep', 'placed');
    if (end < t.frameCount) t = setStateFrom(t, end, 'cut', 'placed');
  }
  return t;
}

export interface SidecarBoundary {
  readonly frame: number;
  readonly ts_ns: string;
  readonly state: State;
  readonly origin: Origin;
  readonly checked: boolean;
}

export interface Effort {
  /** Time with the page visible and the annotator active (playing, keys, pointer). */
  readonly active_ms: number;
  readonly wall_ms: number;
  readonly edits: number;
  readonly undos: number;
}

export interface Sidecar {
  readonly schema_version: 1;
  readonly tool_version: string;
  readonly guideline_version: string | null;
  readonly annotator_id: string;
  /** Assigned by the server on each save, with `saved_at`. */
  readonly revision: number;
  readonly saved_at: string;
  readonly frame_count: number;
  readonly boundaries: readonly SidecarBoundary[];
  readonly review_reason: ReviewReason | null;
  readonly resume: { readonly frame: number; readonly playback_rate: number };
  readonly effort: Effort;
}

/** The sidecar as the client sends it; the server adds the revision and save time. */
export type SidecarDraft = Omit<Sidecar, 'revision' | 'saved_at'>;

export function sidecarBoundaries(t: Timeline, frames: FrameMap): SidecarBoundary[] {
  assertSameFrames(t, frames);
  return t.boundaries.map((b) => ({ ...b, ts_ns: String(frameNs(frames, b.frame)) }));
}

/** Everything wrong with a sidecar draft; an empty list means it is valid for these frames. */
export function validateSidecarDraft(value: unknown, frames: FrameMap): string[] {
  if (!isRecord(value)) return ['the sidecar must be a JSON object'];
  const problems: string[] = [];
  if (value.schema_version !== 1) problems.push('schema_version must be 1');
  for (const field of ['tool_version', 'annotator_id'] as const) {
    if (typeof value[field] !== 'string') problems.push(`${field} must be a string`);
  }
  if (value.guideline_version !== null && typeof value.guideline_version !== 'string') {
    problems.push('guideline_version must be a string or null');
  }
  if (value.review_reason !== null && !isOneOf(REVIEW_REASONS, value.review_reason)) {
    problems.push(`review_reason must be null or one of ${REVIEW_REASONS.join(', ')}`);
  }
  if (value.frame_count !== frameCount(frames)) {
    problems.push(`frame_count must be ${frameCount(frames)}`);
  }
  const { resume, effort } = value;
  if (
    !isRecord(resume) ||
    !isCount(resume.frame) ||
    resume.frame >= frameCount(frames) ||
    !isPositive(resume.playback_rate)
  ) {
    problems.push('resume must hold a frame of the recording and a playback rate');
  }
  const counters = ['active_ms', 'wall_ms', 'edits', 'undos'];
  if (!isRecord(effort) || !counters.every((key) => isCount(effort[key]))) {
    problems.push(`effort must hold non-negative integers ${counters.join(', ')}`);
  }
  if (!Array.isArray(value.boundaries)) problems.push('boundaries must be an array');
  else {
    try {
      timelineFromSidecar(value.boundaries, frames);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return problems;
}

/** Restores the exact timeline from sidecar boundaries; throws if they don't fit the frames. */
export function timelineFromSidecar(boundaries: readonly unknown[], frames: FrameMap): Timeline {
  const restored = boundaries.map((value, i): Boundary => {
    const at = `boundaries[${i}]`;
    if (
      !isRecord(value) ||
      !isCount(value.frame) ||
      !isOneOf(STATES, value.state) ||
      !isOneOf(ORIGINS, value.origin) ||
      typeof value.checked !== 'boolean'
    ) {
      throw new Error(`${at} is malformed`);
    }
    if (
      value.frame >= frameCount(frames) ||
      !isNsString(value.ts_ns) ||
      frames.tsNs[value.frame] !== parseNs(value.ts_ns)
    ) {
      throw new Error(`${at} does not match the reference frames`);
    }
    if (!value.checked && value.origin !== 'live') {
      throw new Error(`${at}: only a live position can be unchecked`);
    }
    return { frame: value.frame, state: value.state, origin: value.origin, checked: value.checked };
  });
  restored.forEach((b, i) => {
    if (i > 0 && b.frame <= restored[i - 1]!.frame)
      throw new Error(`boundaries[${i}] is out of order`);
  });
  return { frameCount: frameCount(frames), boundaries: restored };
}

function assertSameFrames(t: Timeline, frames: FrameMap): void {
  if (t.frameCount !== frameCount(frames)) {
    throw new RangeError(
      `timeline has ${t.frameCount} frames, the frame map ${frameCount(frames)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return (options as readonly unknown[]).includes(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
