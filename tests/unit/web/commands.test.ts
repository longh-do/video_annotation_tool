import { describe, expect, test } from 'vitest';
import { emptyTimeline } from '../../../src/core/timeline.ts';
import { createCommands } from '../../../src/web/commands.ts';
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
  const editor = new Store<EditorState, EditorAction>(
    editorReducer,
    createEditor(emptyTimeline(200)),
  );
  const commands = createCommands({
    player,
    editor,
    canEdit: () => canEdit,
    sound: () => false,
    setSpeed: () => {},
    toggleHelp: () => {},
    submit: () => {},
    noTask: () => {},
    needsReview: () => {},
    playAround: () => {},
  });
  const run = (command: keyof typeof commands) => {
    const handler = commands[command];
    if (typeof handler === 'function') handler();
  };
  return { player, editor, run, seeks };
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

  test('Enter does nothing during playback: a live mark is never confirmed unseen', () => {
    const { editor, run } = setup(40, true);
    run('keep');
    run('accept');
    expect(boundaries(editor)[0]?.checked).toBe(false);
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
});
