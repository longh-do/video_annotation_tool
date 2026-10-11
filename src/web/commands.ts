/**
 * What each key does, and what the mouse does on the timelines and the filmstrip, under the same
 * rules. Handlers read the player and the editor at the moment of the key press, never a value
 * captured at the last render: a held key fires faster than React renders.
 */
import { nextToCheck } from '../core/check.ts';
import type { State } from '../core/timeline.ts';
import { tick } from './audio.ts';
import { type EditorAction, type EditorState, selectedIndex } from './editor.ts';
import type { Command, KeyHandler } from './keymap.ts';
import { DEFAULT_SPEED, type Player, SPEEDS } from './player/player.ts';
import type { Store } from './store.ts';

export interface CommandContext {
  readonly player: Player;
  readonly editor: Store<EditorState, EditorAction>;
  /** False while editing is unsafe or impossible. */
  readonly canEdit: () => boolean;
  readonly sound: () => boolean;
  readonly setSpeed: (speed: number) => void;
  readonly toggleHelp: () => void;
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

  const speed = (index: number) => () => ctx.setSpeed(SPEEDS[index] ?? DEFAULT_SPEED);

  return {
    playPause: () => player.togglePlay(),
    keep: mark('keep'),
    cut: mark('cut'),
    accept: editing(() => {
      // The check pass happens paused. A mark is confirmed only while it is on screen, i.e. once
      // the annotator has looked at it; otherwise Enter goes to the next rough mark. Enter while
      // playing around the mark ends the replay on it and confirms it.
      const index = selectedIndex(editor.getState());
      const selected = timeline().boundaries[index]?.frame;
      if (player.snapshot.around && selected !== undefined) player.seek(selected);
      else if (live()) return;
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
    rewind: () => player.rewind(2),
    speed1: speed(0),
    speed2: speed(1),
    speed3: speed(2),
    speed4: speed(3),
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
    moveHere: editing(() => {
      editor.dispatch({
        type: 'move-nearest',
        frame: player.frame,
        origin: live() ? 'live' : 'placed',
      });
    }),
    flip: editing(() => editor.dispatch({ type: 'flip', frame: player.frame })),
    deleteBoundary: editing(() => editor.dispatch({ type: 'delete-selected' })),
    playAround: () => player.playAround(editor.getState().selected ?? Math.max(player.frame, 0)),
    noTask: editing(() => ctx.noTask()),
    needsReview: editing(() => ctx.needsReview()),
    help: () => ctx.toggleHelp(),
  };
}

/** What the mouse does: the interval list, the filmstrip, and dragging boundary handles. */
export interface PointerActions {
  /** Select a boundary and show it. */
  readonly goTo: (frame: number) => void;
  /** A filmstrip thumbnail: the selected boundary moves to that frame. */
  readonly pick: (frame: number) => void;
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
    pick: (frame) => {
      const index = selectedIndex(editor.getState());
      if (!ctx.canEdit() || index < 0) return;
      showSelected(ctx, editor.dispatch({ type: 'move', index, frame, origin: 'placed' }));
    },
    dragStart: (index) => {
      if (ctx.canEdit()) showSelected(ctx, editor.dispatch({ type: 'drag-start', index }));
    },
    drag: (index, frame) => {
      if (!dragging()) return;
      showSelected(ctx, editor.dispatch({ type: 'move', index, frame, origin: 'drag' }));
    },
    dragEnd: () => {
      if (dragging()) editor.dispatch({ type: 'drag-end' });
    },
    dragCancel: () => {
      if (dragging()) showSelected(ctx, editor.dispatch({ type: 'drag-cancel' }));
    },
  };
}
