/**
 * What each key does, and what the mouse does on the timeline and in the interval list, under
 * the same rules. Handlers read the player and the editor at the moment of the key press, never a
 * value captured at the last render: a held key fires faster than React renders.
 */
import { nextToCheck } from '../core/check.ts';
import type { State } from '../core/timeline.ts';
import { tick } from './audio.ts';
import { type EditorAction, type EditorState, selectedIndex } from './editor.ts';
import type { Command, KeyHandler } from './keymap.ts';
import type { Player } from './player/player.ts';
import type { Store } from './store.ts';

export interface CommandContext {
  readonly player: Player;
  readonly editor: Store<EditorState, EditorAction>;
  /** False while editing is unsafe or impossible. */
  readonly canEdit: () => boolean;
  readonly sound: () => boolean;
  /** Zooms the timeline: in or out around the playhead, or out to the whole recording. */
  readonly zoom: (how: 'in' | 'out' | 'fit') => void;
  readonly toggleCommandMenu: () => void;
  readonly submit: () => void;
  readonly noTask: () => void;
  readonly needsReview: () => void;
}

/** Select a boundary and show its first frame. */
function goTo({ player, editor }: CommandContext, frame: number | undefined): void {
  if (frame === undefined) return;
  editor.dispatch({ type: 'select', frame });
  player.seek(frame);
}

/** Show where an edit left the selected boundary. */
function showSelected({ player }: CommandContext, state: EditorState): void {
  if (state.selected !== null) player.seek(state.selected);
}

export function createCommands(ctx: CommandContext): Record<Command, KeyHandler> {
  const { player, editor } = ctx;
  const timeline = () => editor.getState().history.present;
  /** Marks made during playback are rough (reaction time); marks made while paused are exact. */
  const live = () => player.snapshot.playing;
  const editing = (run: () => void) => () => {
    if (ctx.canEdit()) run();
  };

  const mark = (state: State) =>
    editing(() => {
      const frame = player.frame;
      if (frame < 0) return;
      const before = editor.getState();
      const after = editor.dispatch({
        type: 'mark',
        frame,
        state,
        origin: live() ? 'live' : 'paused',
      });
      if (after !== before) tick(state, !ctx.sound());
    });

  const nudge = (delta: number) =>
    editing(() =>
      showSelected(ctx, editor.dispatch({ type: 'nudge', delta, now: performance.now() })),
    );

  /** Undo and redo show the boundary they put back, when it is the one being worked on. */
  const history = (type: 'undo' | 'redo') =>
    editing(() => {
      const before = editor.getState().selected;
      const after = editor.dispatch({ type });
      if (after.selected !== before) showSelected(ctx, after);
    });

  return {
    playPause: () => player.togglePlay(),
    keep: mark('keep'),
    cut: mark('cut'),
    accept: editing(() => {
      // The check pass happens paused. A mark is confirmed only while it is on screen, i.e. once
      // the annotator has looked at it; otherwise Enter goes to the next mark to check (during
      // playback too: it stops there, unconfirmed).
      if (live()) {
        goTo(ctx, timeline().boundaries[nextToCheck(timeline(), player.frame)]?.frame);
        return;
      }
      const index = selectedIndex(editor.getState());
      const selected = timeline().boundaries[index]?.frame;
      const here = player.frame;
      const onIt = selected === here;
      if (onIt) editor.dispatch({ type: 'confirm', index });
      const next = nextToCheck(timeline(), onIt ? here : here - 1);
      goTo(ctx, timeline().boundaries[next]?.frame);
    }),
    undo: history('undo'),
    redo: history('redo'),
    submit: editing(() => ctx.submit()),
    back1: () => void player.step(-1),
    forward1: () => void player.step(1),
    back10: () => void player.step(-10),
    forward10: () => void player.step(10),
    skim: { press: () => player.skim(true), release: () => player.skim(false) },
    previousBoundary: () => {
      const here = player.frame;
      goTo(ctx, timeline().boundaries.findLast((b) => b.frame < here)?.frame);
    },
    nextBoundary: () => {
      const here = player.frame;
      goTo(ctx, timeline().boundaries.find((b) => b.frame > here)?.frame);
    },
    nudgeBack1: nudge(-1),
    nudgeForward1: nudge(1),
    nudgeBack10: nudge(-10),
    nudgeForward10: nudge(10),
    deleteSelected: editing(() => editor.dispatch({ type: 'delete-selected' })),
    zoomIn: () => ctx.zoom('in'),
    zoomOut: () => ctx.zoom('out'),
    zoomFit: () => ctx.zoom('fit'),
    noTask: editing(() => ctx.noTask()),
    needsReview: editing(() => ctx.needsReview()),
    commandMenu: () => ctx.toggleCommandMenu(),
  };
}

/** What the mouse does: the timeline, its menu and the interval list. */
export interface PointerActions {
  /** Select a boundary and show it. */
  readonly goTo: (frame: number) => void;
  /** Select a kept interval (or, with null, nothing) and show `frame`, if given. */
  readonly selectInterval: (start: number | null, frame: number | null) => void;
  /** A boundary's badge on the timeline. */
  readonly deleteBoundary: (index: number) => void;
  /** The timeline's menu: every frame in [from, to) becomes `state`. */
  readonly setRange: (from: number, to: number, state: State) => void;
  readonly dragStart: (index: number) => void;
  /** The video follows the handle, so the frame under the pointer is on screen. */
  readonly drag: (index: number, frame: number) => void;
  readonly dragEnd: () => void;
  readonly dragCancel: () => void;
}

export function createPointerActions(ctx: CommandContext): PointerActions {
  const { editor } = ctx;
  // A drag only starts when editing is allowed; its moves never check again (canEdit is false
  // during a drag, so that keys don't edit mid-drag).
  const dragging = () => editor.getState().history.gestureBase !== null;
  return {
    goTo: (frame) => goTo(ctx, frame),
    selectInterval: (start, frame) => {
      editor.dispatch({ type: 'select-interval', start });
      if (frame !== null) ctx.player.seek(frame);
    },
    deleteBoundary: (index) => {
      if (ctx.canEdit()) editor.dispatch({ type: 'delete-boundary', index });
    },
    setRange: (from, to, state) => {
      if (ctx.canEdit()) editor.dispatch({ type: 'set-range', from, to, state });
    },
    dragStart: (index) => {
      if (ctx.canEdit()) showSelected(ctx, editor.dispatch({ type: 'drag-start', index }));
    },
    drag: (index, frame) => {
      if (!dragging()) return;
      showSelected(ctx, editor.dispatch({ type: 'move', index, frame }));
    },
    dragEnd: () => {
      if (dragging()) editor.dispatch({ type: 'drag-end' });
    },
    dragCancel: () => {
      if (dragging()) showSelected(ctx, editor.dispatch({ type: 'drag-cancel' }));
    },
  };
}
