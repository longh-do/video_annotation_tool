/**
 * Undo and redo over immutable snapshots.
 *
 * Timeline operations return a new value (or the same one when nothing changed), so the history
 * only keeps references and unchanged parts are shared between steps. Grouping rules:
 * - every `commit` is one step, except that commits sharing a `run` key within `RUN_WINDOW_MS`
 *   of each other merge into one step (holding a nudge key down);
 * - a gesture (`beginGesture` … `endGesture`, e.g. a drag) is one step, and `cancelGesture` or an
 *   undo during it reverts it. Compute each step of a gesture from `gestureBase`, not from
 *   `present`: a drag that returns to its start then yields the very same object, and no step.
 * View state (playhead, zoom, selection) never goes through the history.
 */

export const RUN_WINDOW_MS = 500;

export interface History<S> {
  readonly past: readonly S[];
  readonly present: S;
  readonly future: readonly S[];
  /** The open run of mergeable commits, if any. */
  readonly run: { readonly key: string; readonly at: number } | null;
  /** The state before an open gesture, if any. */
  readonly gestureBase: S | null;
}

/** Commits with the same key in quick succession merge into one undo step. */
export interface Run {
  readonly key: string;
  /** Milliseconds on any monotonic clock. */
  readonly now: number;
}

export function createHistory<S>(initial: S): History<S> {
  return { past: [], present: initial, future: [], run: null, gestureBase: null };
}

export function commit<S>(h: History<S>, next: S, run?: Run): History<S> {
  if (next === h.present) return h;
  if (h.gestureBase !== null) return { ...h, present: next };
  const merges = run !== undefined && h.run?.key === run.key && run.now - h.run.at <= RUN_WINDOW_MS;
  return {
    past: merges ? h.past : [...h.past, h.present],
    present: next,
    future: [],
    run: run === undefined ? null : { key: run.key, at: run.now },
    gestureBase: null,
  };
}

/** Ends a run early, e.g. when the nudge key is released. */
export function closeRun<S>(h: History<S>): History<S> {
  return h.run === null ? h : { ...h, run: null };
}

export function beginGesture<S>(h: History<S>): History<S> {
  return h.gestureBase !== null ? h : { ...h, run: null, gestureBase: h.present };
}

/** One undo step for the whole gesture, or none if it ended where it started. */
export function endGesture<S>(h: History<S>): History<S> {
  const base = h.gestureBase;
  if (base === null) return h;
  if (h.present === base) return { ...h, gestureBase: null };
  return { ...h, past: [...h.past, base], future: [], gestureBase: null };
}

export function cancelGesture<S>(h: History<S>): History<S> {
  const base = h.gestureBase;
  return base === null ? h : { ...h, present: base, gestureBase: null };
}

export function canUndo<S>(h: History<S>): boolean {
  return h.gestureBase !== null || h.past.length > 0;
}

export function canRedo<S>(h: History<S>): boolean {
  return h.gestureBase === null && h.future.length > 0;
}

export function undo<S>(h: History<S>): History<S> {
  if (h.gestureBase !== null) return cancelGesture(h);
  const previous = h.past.at(-1);
  if (previous === undefined) return h;
  return {
    past: h.past.slice(0, -1),
    present: previous,
    future: [...h.future, h.present],
    run: null,
    gestureBase: null,
  };
}

export function redo<S>(h: History<S>): History<S> {
  const next = h.future.at(-1);
  if (h.gestureBase !== null || next === undefined) return h;
  return {
    past: [...h.past, h.present],
    present: next,
    future: h.future.slice(0, -1),
    run: null,
    gestureBase: null,
  };
}
