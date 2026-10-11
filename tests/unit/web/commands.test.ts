import { describe, expect, test } from 'vitest';
import { emptyTimeline } from '../../../src/core/timeline.ts';
import { createCommands, createPointerActions } from '../../../src/web/commands.ts';
import {
  createEditor,
  type EditorAction,
  type EditorState,
  editorReducer,
} from '../../../src/web/editor.ts';
import type { Player } from '../../../src/web/player/player.ts';
import { Store } from '../../../src/web/store.ts';

/** A player that only records what it is asked to do. */
function fakePlayer(frame: number, playing: boolean) {
  const seeks: number[] = [];
  const player = {
    frame,
    snapshot: { frame, playing, speed: 2, skimming: false, seekFailed: false },
    seek(to: number) {
      seeks.push(to);
      player.frame = to;
    },
  };
  return { player: player as unknown as Player & { frame: number }, seeks };
}

function setup(frame: number, playing: boolean, canEdit = true) {
  const { player, seeks } = fakePlayer(frame, playing);
  const zooms: string[] = [];
  const editor = new Store<EditorState, EditorAction>(
    editorReducer,
    createEditor(emptyTimeline(200)),
  );
  const context = {
    player,
    editor,
    canEdit: () => canEdit && editor.getState().history.gestureBase === null,
    sound: () => false,
    zoom: (how: string) => void zooms.push(how),
    toggleCommandMenu: () => {},
    submit: () => {},
    noTask: () => {},
    needsReview: () => {},
  };
  const commands = createCommands(context);
  const run = (command: keyof typeof commands) => {
    const handler = commands[command];
    if (typeof handler === 'function') handler();
  };
  return { player, editor, run, seeks, zooms, pointer: createPointerActions(context) };
}

const boundaries = (editor: Store<EditorState, EditorAction>) =>
  editor.getState().history.present.boundaries;

describe('commands', () => {
  test('a mark during playback is rough; a mark while paused is exact, at the frame being shown', () => {
    const playing = setup(40, true);
    playing.run('keep');
    expect(boundaries(playing.editor)).toEqual([
      { frame: 40, state: 'keep', origin: 'live', checked: false },
    ]);
    const paused = setup(40, false);
    paused.run('keep');
    expect(boundaries(paused.editor)[0]).toMatchObject({ origin: 'paused', checked: true });
  });

  test('nothing is marked while editing is off', () => {
    const { editor, run } = setup(40, false, false);
    run('keep');
    expect(boundaries(editor)).toEqual([]);
  });

  test('Enter during playback stops on the next mark to check, never confirming it unseen', () => {
    const { editor, run, seeks } = setup(40, true);
    run('keep');
    run('accept');
    expect(boundaries(editor)[0]?.checked).toBe(false);
    expect(seeks.at(-1)).toBe(40);
    expect(editor.getState().selected).toBe(40);
  });

  test('Enter goes to the next rough mark first, and confirms it only once it is on screen', () => {
    const { player, editor, run, seeks } = setup(40, true);
    run('keep');
    player.frame = 90;
    run('cut');
    Object.assign(player.snapshot, { playing: false });
    player.frame = 120; // paused past both marks
    run('accept');
    expect(seeks).toEqual([40]);
    expect(boundaries(editor).map((b) => b.checked)).toEqual([false, false]);
    run('accept');
    expect(boundaries(editor).map((b) => b.checked)).toEqual([true, false]);
    expect(seeks).toEqual([40, 90]);
  });

  test('nudging moves the selected boundary and shows its new first frame', () => {
    const { player, editor, run, seeks } = setup(40, false);
    run('keep');
    run('nudgeBack10');
    expect(boundaries(editor)[0]?.frame).toBe(30);
    expect(seeks.at(-1)).toBe(30);
    expect(player.frame).toBe(30);
  });

  test('undoing a nudge shows the boundary back where it was, still selected', () => {
    const { editor, run, seeks } = setup(40, false);
    run('keep');
    run('nudgeBack1');
    run('undo');
    expect(editor.getState().selected).toBe(40);
    expect(seeks.at(-1)).toBe(40);
  });

  test('the zoom keys zoom the timeline', () => {
    const { run, zooms } = setup(40, false, false);
    run('zoomIn');
    run('zoomOut');
    run('zoomFit');
    expect(zooms).toEqual(['in', 'out', 'fit']);
  });

  test("a badge click deletes that boundary; the menu's ranges delete and merge intervals", () => {
    const { editor, pointer } = setup(40, false);
    for (const [frame, state] of [
      [10, 'keep'],
      [20, 'cut'],
      [30, 'keep'],
      [40, 'cut'],
    ] as const) {
      editor.dispatch({ type: 'mark', frame, state, origin: 'paused' });
    }
    pointer.setRange(20, 30, 'keep'); // merge
    expect(boundaries(editor).map((b) => b.frame)).toEqual([10, 40]);
    pointer.deleteBoundary(1);
    expect(boundaries(editor).map((b) => b.frame)).toEqual([10]);
    pointer.setRange(10, 200, 'cut'); // delete the interval
    expect(boundaries(editor)).toEqual([]);
  });

  test('selecting an interval shows the frame asked for, or stays put', () => {
    const { editor, pointer, seeks } = setup(40, false);
    editor.dispatch({ type: 'mark', frame: 10, state: 'keep', origin: 'paused' });
    pointer.selectInterval(10, 25);
    expect(editor.getState()).toMatchObject({ interval: 10, selected: null });
    expect(seeks.at(-1)).toBe(25);
    pointer.selectInterval(null, null);
    expect(editor.getState().interval).toBe(null);
    expect(seeks).toHaveLength(1);
  });

  test('Backspace deletes the selected interval when no boundary is selected', () => {
    const { editor, run, pointer } = setup(40, false);
    editor.dispatch({ type: 'mark', frame: 10, state: 'keep', origin: 'paused' });
    editor.dispatch({ type: 'mark', frame: 20, state: 'cut', origin: 'paused' });
    pointer.selectInterval(10, null);
    run('deleteSelected');
    expect(boundaries(editor)).toEqual([]);
  });

  test('a drag shows the frame under the pointer, and is one undo step or nothing at all', () => {
    const { editor, run, seeks, pointer } = setup(40, false);
    run('keep');
    pointer.dragStart(0);
    pointer.drag(0, 45);
    run('keep'); // keys don't edit mid-drag
    pointer.drag(0, 48);
    expect(seeks.slice(-2)).toEqual([45, 48]);
    pointer.dragEnd();
    expect(boundaries(editor).map((b) => b.frame)).toEqual([48]);
    run('undo');
    expect(boundaries(editor).map((b) => b.frame)).toEqual([40]);

    pointer.dragStart(0);
    pointer.drag(0, 60);
    pointer.dragCancel();
    expect(boundaries(editor).map((b) => b.frame)).toEqual([40]);
    expect(seeks.at(-1)).toBe(40);
  });

  test('no drag, badge or menu edits while editing is off', () => {
    const { editor, pointer } = setup(40, false, false);
    editor.dispatch({ type: 'mark', frame: 40, state: 'keep', origin: 'live' });
    pointer.dragStart(0);
    pointer.drag(0, 50);
    pointer.dragEnd();
    pointer.deleteBoundary(0);
    pointer.setRange(40, 200, 'cut');
    expect(boundaries(editor)[0]?.frame).toBe(40);
  });
});
