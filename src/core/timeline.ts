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
  'placed', // put on a chosen frame: a filmstrip click, or T while paused
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
  /** Strictly increasing frames, each in [0, frameCount). */
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
 * Nudge, drag, T and filmstrip clicks. Clamped between the neighbours, never past them. Choosing
 * the frame a live mark already sits on confirms it, like Enter in the check pass.
 */
export function moveBoundary(t: Timeline, index: number, frame: number, origin: Origin): Timeline {
  const boundary = boundaryAt(t, index);
  if (!Number.isInteger(frame)) throw new RangeError(`frame ${frame} is not an integer`);
  const lo = (t.boundaries[index - 1]?.frame ?? -1) + 1;
  const hi = (t.boundaries[index + 1]?.frame ?? t.frameCount) - 1;
  const to = Math.min(Math.max(frame, lo), hi);
  if (to === boundary.frame) return origin === 'live' ? t : markChecked(t, index);
  const moved: Boundary = { ...boundary, frame: to, origin, checked: origin !== 'live' };
  return withBoundaries(t, t.boundaries.with(index, moved));
}

/** X: flip the run under `frame` between keep and cut, up to the next boundary. */
export function flipSegmentAt(t: Timeline, frame: number): Timeline {
  assertFrame(t, frame);
  const i = boundaryIndexAt(t, frame);
  const boundary = t.boundaries[i];
  if (!boundary) {
    // Before the first boundary everything is cut: keep from the very first frame instead.
    const first: Boundary = { frame: 0, state: 'keep', origin: 'placed', checked: true };
    return withBoundaries(t, [first, ...t.boundaries]);
  }
  return withBoundaries(t, t.boundaries.with(i, { ...boundary, state: opposite(boundary.state) }));
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
 * A through boundary has the same state on both sides, so it changes nothing in the output.
 * It stays on the timeline (drawn dotted) to keep later edits local: deleting the boundary that
 * made it redundant brings it back into effect.
 */
export function isThrough(t: Timeline, index: number): boolean {
  const before = t.boundaries[index - 1]?.state ?? 'cut';
  return boundaryAt(t, index).state === before;
}

/** The timeline as maximal runs of one state, with through boundaries merged away. */
export function segments(t: Timeline): Segment[] {
  const runs: Segment[] = [];
  let start = 0;
  let state: State = 'cut';
  for (const boundary of t.boundaries) {
    if (boundary.state === state) continue;
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

/** Index of the boundary nearest to `frame` (the earlier one on a tie), or -1 if there are none. */
export function nearestBoundary(t: Timeline, frame: number): number {
  const before = boundaryIndexAt(t, frame);
  const after = before + 1;
  if (after >= t.boundaries.length) return before;
  if (before < 0) return after;
  const toBefore = frame - t.boundaries[before]!.frame;
  const toAfter = t.boundaries[after]!.frame - frame;
  return toBefore <= toAfter ? before : after;
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
  return { frameCount: t.frameCount, boundaries };
}

function opposite(state: State): State {
  return state === 'keep' ? 'cut' : 'keep';
}
