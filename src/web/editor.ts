/**
 * The annotation being edited: its timeline with undo history, the selection (a boundary, or a
 * kept interval), and the outcome (status, note, review reason). A pure reducer, so every editing
 * rule is unit-tested without a browser.
 *
 * The outcome only stands for the timeline it was given for: any change to the timeline, undo
 * included, turns a submitted annotation back into a draft.
 */
import type { ReviewReason, Status } from '../core/annotation.ts';
import {
  beginGesture,
  cancelGesture,
  closeRun,
  commit,
  createHistory,
  endGesture,
  type History,
  type Run,
  redo,
  undo,
} from '../core/history.ts';
import {
  clearAll,
  deleteBoundary,
  keepSegments,
  markChecked,
  moveBoundary,
  type Origin,
  type Segment,
  type State,
  setRange,
  setStateFrom,
  type Timeline,
} from '../core/timeline.ts';

export interface Outcome {
  readonly status: Status;
  readonly notes: string;
  readonly reviewReason: ReviewReason | null;
}

export interface EditorState {
  readonly history: History<Timeline>;
  /** Frame of the selected boundary. View state: undo never records it. */
  readonly selected: number | null;
  /**
   * Where the selected boundary was when work on it began: one visit of the check pass, for its
   * timing, however far the boundary moves meanwhile.
   */
  readonly anchor: number | null;
  /**
   * Start frame of the selected kept interval, when an interval rather than a boundary is
   * selected (a click on it, on the timeline or in the list). View state too.
   */
  readonly interval: number | null;
  readonly outcome: Outcome;
  /** Effort counters, saved in the sidecar. */
  readonly edits: number;
  readonly undos: number;
}

export type EditorAction =
  /** S or D at a frame. */
  | {
      readonly type: 'mark';
      readonly frame: number;
      readonly state: State;
      readonly origin: Origin;
    }
  /** A drag of a known boundary. */
  | {
      readonly type: 'move';
      readonly index: number;
      readonly frame: number;
      readonly origin: Origin;
    }
  /** , and . on the selected boundary; a held key is one undo step. */
  | { readonly type: 'nudge'; readonly delta: number; readonly now: number }
  /** The timeline's menu: delete an interval, merge two, keep a cut stretch. */
  | {
      readonly type: 'set-range';
      readonly from: number;
      readonly to: number;
      readonly state: State;
    }
  /** A click on a boundary's badge. */
  | { readonly type: 'delete-boundary'; readonly index: number }
  /** Backspace: the selected boundary, or else the selected interval. */
  | { readonly type: 'delete-selected' }
  /** Enter in the check pass. */
  | { readonly type: 'confirm'; readonly index: number }
  | { readonly type: 'select'; readonly frame: number | null }
  | { readonly type: 'select-interval'; readonly start: number | null }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  /** A boundary handle is grabbed: it is selected, and the drag becomes one undo step. */
  | { readonly type: 'drag-start'; readonly index: number }
  | { readonly type: 'drag-end' }
  /** Escape during a drag: the boundary goes back, still selected. */
  | { readonly type: 'drag-cancel' }
  | { readonly type: 'close-run' }
  | { readonly type: 'submit' }
  | { readonly type: 'no-task' }
  | { readonly type: 'needs-review'; readonly reason: ReviewReason; readonly notes: string };

const DRAFT: Outcome = { status: 'not_reviewed', notes: '', reviewReason: null };

export function createEditor(
  timeline: Timeline,
  outcome: Outcome = DRAFT,
  counts = { edits: 0, undos: 0 },
): EditorState {
  return {
    history: createHistory(timeline),
    selected: null,
    anchor: null,
    interval: null,
    outcome,
    ...counts,
  };
}

type Selection = Pick<EditorState, 'selected' | 'anchor' | 'interval'>;

/** Selecting a boundary starts work on it: the anchor is where it is now. */
function selecting(frame: number | null): Selection {
  return { selected: frame, anchor: frame, interval: null };
}

function selectingInterval(start: number | null): Selection {
  return { selected: null, anchor: null, interval: start };
}

function unchanged(state: EditorState): Selection {
  return { selected: state.selected, anchor: state.anchor, interval: state.interval };
}

/** Index of the selected boundary, or -1. */
export function selectedIndex(state: EditorState): number {
  return state.history.present.boundaries.findIndex((b) => b.frame === state.selected);
}

/** The selected kept interval, if an interval is selected. */
export function selectedInterval(state: EditorState): Segment | null {
  return keepSegments(state.history.present).find((s) => s.start === state.interval) ?? null;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const present = state.history.present;
  switch (action.type) {
    case 'mark':
      return edit(
        state,
        setStateFrom(present, action.frame, action.state, action.origin),
        selecting(action.frame),
      );
    case 'move':
      return moveTo(state, action.index, action.frame, action.origin);
    case 'nudge': {
      const index = selectedIndex(state);
      if (index < 0) return state;
      const frame = present.boundaries[index]!.frame + action.delta;
      return moveTo(state, index, frame, 'nudge', { key: `nudge:${index}`, now: action.now });
    }
    case 'set-range': {
      const timeline = setRange(present, action.from, action.to, action.state);
      // What was kept stays selected, e.g. two intervals merged into one.
      const kept = keepSegments(timeline).find(
        (s) => s.start <= action.from && action.from < s.end,
      );
      return edit(state, timeline, selectingInterval(kept?.start ?? null));
    }
    case 'delete-boundary':
      return present.boundaries[action.index]
        ? edit(state, deleteBoundary(present, action.index), selecting(null))
        : state;
    case 'delete-selected': {
      const index = selectedIndex(state);
      if (index >= 0) return edit(state, deleteBoundary(present, index), selecting(null));
      const interval = selectedInterval(state);
      if (!interval) return state;
      return edit(state, setRange(present, interval.start, interval.end, 'cut'), selecting(null));
    }
    case 'confirm': {
      const frame = present.boundaries[action.index]?.frame ?? null;
      const selection = frame === state.selected ? unchanged(state) : selecting(frame);
      return edit(state, markChecked(present, action.index), selection);
    }
    case 'select':
      // Even if it is selected already: landing on a boundary starts work on it afresh.
      return { ...state, ...selecting(action.frame) };
    case 'select-interval':
      return { ...state, ...selectingInterval(action.start) };
    case 'undo':
    case 'redo': {
      const history = (action.type === 'undo' ? undo : redo)(state.history);
      if (history === state.history) return state;
      const undos = state.undos + (action.type === 'undo' ? 1 : 0);
      return {
        ...state,
        ...reselect(state, history.present),
        history,
        undos,
        outcome: draft(state.outcome),
      };
    }
    case 'drag-start': {
      const frame = present.boundaries[action.index]?.frame;
      if (frame === undefined) return state;
      const selection = frame === state.selected ? unchanged(state) : selecting(frame);
      // Trimming the selected interval keeps it selected.
      const interval = edgeOfSelected(state, frame) ? state.interval : null;
      return { ...state, ...selection, interval, history: beginGesture(state.history) };
    }
    case 'drag-end': {
      const history = endGesture(state.history);
      if (history === state.history) return state;
      const changed = history.past.length > state.history.past.length;
      return { ...state, history, edits: state.edits + (changed ? 1 : 0) };
    }
    case 'drag-cancel': {
      const history = cancelGesture(state.history);
      if (history === state.history) return state;
      // A drag keeps the boundary's index, so the selection follows it back, and so does a
      // selected interval whose start it was.
      const selected = history.present.boundaries[selectedIndex(state)]?.frame ?? null;
      const interval = state.interval === state.selected ? selected : state.interval;
      return { ...state, history, selected, interval };
    }
    case 'close-run':
      return { ...state, history: closeRun(state.history) };
    case 'submit':
      return { ...state, outcome: { ...state.outcome, status: 'complete', reviewReason: null } };
    case 'no-task': {
      const cleared = edit(state, clearAll(present), selecting(null));
      return { ...cleared, outcome: { status: 'complete', notes: '', reviewReason: null } };
    }
    case 'needs-review':
      return {
        ...state,
        outcome: { status: 'needs_review', notes: action.notes, reviewReason: action.reason },
      };
  }
}

/**
 * Moves a boundary and selects it where it landed, keeping the anchor if it was already the one
 * being worked on. During a drag, steps start from the drag's base.
 */
function moveTo(
  state: EditorState,
  index: number,
  frame: number,
  origin: Origin,
  run?: Run,
): EditorState {
  const base = state.history.gestureBase ?? state.history.present;
  const timeline = moveBoundary(base, index, frame, origin);
  const was = state.history.present.boundaries[index]?.frame ?? null;
  const landed = timeline.boundaries[index]?.frame ?? null;
  const anchor = was === state.selected ? (state.anchor ?? was) : was;
  // A selected interval whose start moves is still the same interval.
  const interval = state.interval === was ? landed : state.interval;
  return edit(state, timeline, { selected: landed, anchor, interval }, run);
}

/** Whether `frame` is where the selected interval starts or stops. */
function edgeOfSelected(state: EditorState, frame: number): boolean {
  const interval = selectedInterval(state);
  return interval !== null && (frame === interval.start || frame === interval.end);
}

/** Applies a timeline edit; a no-op edit leaves the state untouched. A drag counts once, at its end. */
function edit(
  state: EditorState,
  timeline: Timeline,
  selection: Selection,
  run?: Run,
): EditorState {
  if (timeline === state.history.present) return state;
  const dragging = state.history.gestureBase !== null;
  return {
    ...state,
    ...selection,
    history: commit(state.history, timeline, run),
    outcome: draft(state.outcome),
    edits: state.edits + (dragging ? 0 : 1),
  };
}

/**
 * The selection after undo or redo. A selected boundary that is still there stays selected; one
 * that only moved (same number of boundaries, so same index) is followed, so undoing a nudge
 * leaves the check where it was. A selected interval stays while one still starts there (where
 * its start went, if that was the selected boundary). Otherwise nothing is selected.
 */
function reselect(state: EditorState, timeline: Timeline): Selection {
  const boundary = followSelected(state, timeline);
  const start = state.interval === state.selected ? boundary.selected : state.interval;
  const kept = start !== null && keepSegments(timeline).some((s) => s.start === start);
  return { ...boundary, interval: kept ? start : null };
}

function followSelected(state: EditorState, timeline: Timeline): Omit<Selection, 'interval'> {
  if (timeline.boundaries.some((b) => b.frame === state.selected)) {
    return { selected: state.selected, anchor: state.anchor };
  }
  const index = selectedIndex(state);
  const moved = timeline.boundaries.length === state.history.present.boundaries.length;
  const frame = moved ? (timeline.boundaries[index]?.frame ?? null) : null;
  return frame === null
    ? { selected: null, anchor: null }
    : { selected: frame, anchor: state.anchor };
}

/** Back to a draft, keeping whatever note the annotator wrote. */
function draft(outcome: Outcome): Outcome {
  return outcome.status === 'not_reviewed' ? outcome : { ...DRAFT, notes: outcome.notes };
}
