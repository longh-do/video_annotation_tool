/**
 * The keep/cut timeline of one recording, in frames of its reference camera.
 *
 * Every frame is either kept or cut. The timeline stores only boundaries: a boundary at frame f
 * with state `keep` means "keep from frame f on", until the next boundary. Before the first
 * boundary everything is cut. Positions run from 0 to `frameCount`, which is END: just after the
 * last frame.
 *
 * Boundaries carry an explicit state instead of toggling. That is what makes the S and D keys
 * safe: pressing S where the timeline already keeps changes nothing, and one missed key press
 * cannot invert the rest of the recording.
 *
 * Operations are pure. One that changes nothing returns the same object, so the undo history
 * never records an empty step.
 */

export const STATES = ['keep', 'cut'] as const;
export type State = (typeof STATES)[number];

/** How a boundary got its current position. Only `live` positions are rough. */
export const ORIGINS = [
  'live', // set from the playhead during playback: late by the annotator's reaction time
  'paused', // set with S or D while paused
  'placed', // put on a chosen frame: an edge of a range set from the menu
  'drag', // dragged on the timeline
  'nudge', // stepped frame by frame
] as const;
export type Origin = (typeof ORIGINS)[number];

export interface Boundary {
  readonly frame: number;
  readonly state: State;
  readonly origin: Origin;
  /** False only for a live position that the check pass hasn't confirmed yet. */
  readonly checked: boolean;
}

export interface Timeline {
  readonly frameCount: number;
  /**
   * Strictly increasing frames, each in [0, frameCount), each changing the state: a boundary that
   * would repeat the state before it changes nothing, so it is dropped.
   */
  readonly boundaries: readonly Boundary[];
}

/** A run of frames [start, end) in one state; `end` may be END (`frameCount`). */
export interface Segment {
  readonly start: number;
  readonly end: number;
  readonly state: State;
}

export function emptyTimeline(frameCount: number): Timeline {
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new RangeError(`a timeline needs at least one frame, got ${frameCount}`);
  }
  return { frameCount, boundaries: [] };
}

/** Index of the last boundary at or before `frame`, or -1 when there is none. */
export function boundaryIndexAt(t: Timeline, frame: number): number {
  let lo = 0;
  let hi = t.boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t.boundaries[mid]!.frame <= frame) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function stateAt(t: Timeline, frame: number): State {
  return t.boundaries[boundaryIndexAt(t, frame)]?.state ?? 'cut';
}

/** S and D: keep (or cut) from `frame` up to the next boundary. A no-op if already in `state`. */
export function setStateFrom(t: Timeline, frame: number, state: State, origin: Origin): Timeline {
  assertFrame(t, frame);
  if (stateAt(t, frame) === state) return t;
  const boundary: Boundary = { frame, state, origin, checked: origin !== 'live' };
  const i = boundaryIndexAt(t, frame);
  const replaces = t.boundaries[i]?.frame === frame;
  return withBoundaries(
    t,
    t.boundaries.toSpliced(replaces ? i : i + 1, replaces ? 1 : 0, boundary),
  );
}

/**
 * Nudge and drag. Clamped between the neighbours, never past them. The boundary lands where the
 * annotator put it, so it is exact. A move that can't go anywhere (a neighbour in the way, or
 * dropped where it was) changes nothing, and doesn't confirm a live mark: only a check does.
 */
export function moveBoundary(
  t: Timeline,
  index: number,
  frame: number,
  origin: 'drag' | 'nudge',
): Timeline {
  const boundary = boundaryAt(t, index);
  if (!Number.isInteger(frame)) throw new RangeError(`frame ${frame} is not an integer`);
  const lo = (t.boundaries[index - 1]?.frame ?? -1) + 1;
  const hi = (t.boundaries[index + 1]?.frame ?? t.frameCount) - 1;
  const to = Math.min(Math.max(frame, lo), hi);
  if (to === boundary.frame) return t;
  const moved: Boundary = { ...boundary, frame: to, origin, checked: true };
  return withBoundaries(t, t.boundaries.with(index, moved));
}

/**
 * The timeline's right-click menu: every frame in [from, to) becomes `state` — deleting an
 * interval, merging two by keeping the gap between them, keeping a cut stretch. The boundaries
 * inside the range go; the frames outside it keep their state, and a boundary that stays keeps
 * its origin and check.
 */
export function setRange(t: Timeline, from: number, to: number, state: State): Timeline {
  assertFrame(t, from);
  if (!Number.isInteger(to) || to <= from || to > t.frameCount) {
    throw new RangeError(`range end ${to} is outside ${from + 1}..${t.frameCount}`);
  }
  const before = t.boundaries.filter((b) => b.frame < from);
  const boundaries = [...before];
  if ((before.at(-1)?.state ?? 'cut') !== state) {
    const existing = t.boundaries.find((b) => b.frame === from);
    boundaries.push(existing?.state === state ? existing : placed(from, state));
  }
  if (to < t.frameCount) {
    // From `to` on, the frames keep the state they had.
    const resume = stateAt(t, to);
    const existing = t.boundaries.find((b) => b.frame === to);
    if (resume !== state) boundaries.push(existing ?? placed(to, resume));
  }
  boundaries.push(...t.boundaries.filter((b) => b.frame > to));
  const same =
    boundaries.length === t.boundaries.length && boundaries.every((b, i) => b === t.boundaries[i]);
  return same ? t : withBoundaries(t, boundaries);
}

/** Backspace: remove a boundary; the run before it extends to the next one. */
export function deleteBoundary(t: Timeline, index: number): Timeline {
  boundaryAt(t, index);
  return withBoundaries(t, t.boundaries.toSpliced(index, 1));
}

/** Enter in the check pass: the boundary's position is confirmed. */
export function markChecked(t: Timeline, index: number): Timeline {
  const boundary = boundaryAt(t, index);
  if (boundary.checked) return t;
  return withBoundaries(t, t.boundaries.with(index, { ...boundary, checked: true }));
}

/** N, "no useful task": cut everything. */
export function clearAll(t: Timeline): Timeline {
  return t.boundaries.length === 0 ? t : withBoundaries(t, []);
}

/**
 * The boundaries that change the state. One that repeats the state already in force changes
 * nothing, and left on the timeline it would quietly cut a later interval short (S, then D on the
 * same frame, then S earlier and D later); undo is what brings a dropped boundary back.
 */
export function changesOnly(boundaries: readonly Boundary[]): Boundary[] {
  const kept: Boundary[] = [];
  for (const b of boundaries) if (b.state !== (kept.at(-1)?.state ?? 'cut')) kept.push(b);
  return kept;
}

/** The timeline as maximal runs of one state. */
export function segments(t: Timeline): Segment[] {
  const runs: Segment[] = [];
  let start = 0;
  let state: State = 'cut';
  for (const boundary of t.boundaries) {
    if (boundary.frame > start) runs.push({ start, end: boundary.frame, state });
    start = boundary.frame;
    state = boundary.state;
  }
  runs.push({ start, end: t.frameCount, state });
  return runs;
}

export function keepSegments(t: Timeline): Segment[] {
  return segments(t).filter((s) => s.state === 'keep');
}

function boundaryAt(t: Timeline, index: number): Boundary {
  const boundary = t.boundaries[index];
  if (!boundary) throw new RangeError(`no boundary at index ${index}`);
  return boundary;
}

function assertFrame(t: Timeline, frame: number): void {
  if (!Number.isInteger(frame) || frame < 0 || frame >= t.frameCount) {
    throw new RangeError(`frame ${frame} is outside 0..${t.frameCount - 1}`);
  }
}

function withBoundaries(t: Timeline, boundaries: readonly Boundary[]): Timeline {
  return { frameCount: t.frameCount, boundaries: changesOnly(boundaries) };
}

function placed(frame: number, state: State): Boundary {
  return { frame, state, origin: 'placed', checked: true };
}
