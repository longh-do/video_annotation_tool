/**
 * What each key does. Handlers read the player and the editor at the moment of the key press,
 * never a value captured at the last render: a held key fires faster than React renders.
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
  /** Asked at each key press: false while editing is unsafe or impossible. */
  readonly canEdit: () => boolean;
  readonly sound: () => boolean;
  readonly setSpeed: (speed: number) => void;
  readonly toggleHelp: () => void;
  readonly submit: () => void;
  readonly noTask: () => void;
  readonly needsReview: () => void;
  readonly playAround: () => void;
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

  /** Select a boundary and show its first frame. */
  const goTo = (frame: number | undefined) => {
    if (frame === undefined) return;
    editor.dispatch({ type: 'select', frame });
    player.seek(frame);
  };

  const nudge = (delta: number) =>
    editing(() => {
      const next = editor.dispatch({ type: 'nudge', delta, now: performance.now() });
      if (next.selected !== null) player.seek(next.selected);
    });

  const speed = (index: number) => () => ctx.setSpeed(SPEEDS[index] ?? DEFAULT_SPEED);

  return {
    playPause: () => player.togglePlay(),
    keep: mark('keep'),
    cut: mark('cut'),
    accept: editing(() => {
      // The check pass happens paused. A mark is confirmed only while it is on screen, i.e. once
      // the annotator has looked at it; otherwise Enter goes to the next rough mark.
      if (live()) return;
      const here = player.frame;
      const index = selectedIndex(editor.getState());
      const onIt = timeline().boundaries[index]?.frame === here;
      if (onIt) editor.dispatch({ type: 'confirm', index });
      const next = nextToCheck(timeline(), onIt ? here : here - 1);
      goTo(timeline().boundaries[next]?.frame);
    }),
    undo: editing(() => editor.dispatch({ type: 'undo' })),
    redo: editing(() => editor.dispatch({ type: 'redo' })),
    submit: () => ctx.submit(),
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
      goTo(timeline().boundaries.findLast((b) => b.frame < here)?.frame);
    },
    nextBoundary: () => {
      const here = player.frame;
      goTo(timeline().boundaries.find((b) => b.frame > here)?.frame);
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
    playAround: () => ctx.playAround(),
    noTask: editing(() => ctx.noTask()),
    needsReview: editing(() => ctx.needsReview()),
    help: () => ctx.toggleHelp(),
  };
}
