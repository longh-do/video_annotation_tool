import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BINDINGS,
  type Chord,
  chordLabel,
  IS_MAC,
  installKeymap,
  matches,
} from '../../../src/web/keymap.ts';

const press = (key: string, code: string, mods: Partial<KeyboardEvent> = {}) =>
  ({
    key,
    code,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
  }) as KeyboardEvent;
const mod = IS_MAC ? { metaKey: true } : { ctrlKey: true };

describe('keymap', () => {
  test('no key does two things', () => {
    const chords = BINDINGS.flatMap((b) =>
      b.chords.map((c: Chord) => JSON.stringify({ ...c, command: undefined })),
    );
    expect(new Set(chords).size).toBe(chords.length);
  });

  test('Tab and ⇧Tab are left to the browser, so the keyboard can reach every control', () => {
    const tab = [press('Tab', 'Tab'), press('Tab', 'Tab', { shiftKey: true })];
    const taken = BINDINGS.filter((b) => b.chords.some((c) => tab.some((e) => matches(c, e))));
    expect(taken.map((b) => b.command)).toEqual([]);
  });

  test('letters follow the layout, with the physical key as a fallback for non-Latin layouts', () => {
    const keep = { key: 's' };
    expect(matches(keep, press('s', 'KeyS'))).toBe(true);
    expect(matches(keep, press('s', 'Semicolon'))).toBe(true); // S somewhere else on the layout
    expect(matches(keep, press('ы', 'KeyS'))).toBe(true); // Cyrillic layout
    expect(matches(keep, press('d', 'KeyS'))).toBe(false);
  });

  test('modifiers must match exactly', () => {
    const undo = { key: 'z', mod: true };
    const redo = { key: 'z', mod: true, shift: true };
    expect(matches(undo, press('z', 'KeyZ', mod))).toBe(true);
    expect(matches(undo, press('z', 'KeyZ', { ...mod, shiftKey: true }))).toBe(false);
    expect(matches(redo, press('Z', 'KeyZ', { ...mod, shiftKey: true }))).toBe(true);
    expect(matches({ key: 's' }, press('s', 'KeyS', mod))).toBe(false);
    expect(matches({ key: 's' }, press('s', 'KeyS', { altKey: true }))).toBe(false);
  });

  test('punctuation and digits use the physical key, so Shift still means ×10', () => {
    expect(matches({ code: 'Comma', shift: true }, press('<', 'Comma', { shiftKey: true }))).toBe(
      true,
    );
    expect(matches({ code: 'Comma' }, press('<', 'Comma', { shiftKey: true }))).toBe(false);
    expect(matches({ code: 'Digit3' }, press('"', 'Digit3'))).toBe(true); // AZERTY prints a quote
  });

  test('labels use the platform conventions', () => {
    expect(chordLabel({ key: 'z', mod: true, shift: true })).toBe(IS_MAC ? '⇧⌘Z' : 'Shift+Ctrl+Z');
    expect(chordLabel({ code: 'Space' })).toBe('Space');
    expect(chordLabel({ code: 'Digit3' })).toBe('3');
    expect(chordLabel({ code: 'Comma', shift: true })).toBe(IS_MAC ? '⇧,' : 'Shift+,');
  });
});

/** The page's key listener, in Node: a window to dispatch on, and the elements it tells apart. */
describe('installed keymap', () => {
  class Element {}
  class TextArea extends Element {}
  class Button extends Element {}
  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('HTMLElement', Element);
    vi.stubGlobal('HTMLTextAreaElement', TextArea);
    vi.stubGlobal('HTMLButtonElement', Button);
    for (const name of ['HTMLSelectElement', 'HTMLInputElement', 'HTMLAnchorElement']) {
      vi.stubGlobal(name, class extends Element {});
    }
  });
  afterEach(() => vi.unstubAllGlobals());

  const send = (
    type: 'keydown' | 'keyup',
    key: string,
    code: string,
    init: { readonly repeat?: boolean; readonly target?: object } = {},
  ) => {
    const event = new Event(type, { cancelable: true });
    const fields = { key, code, repeat: init.repeat ?? false, target: init.target ?? null };
    for (const [name, value] of Object.entries({
      ...fields,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      isComposing: false,
    })) {
      Object.defineProperty(event, name, { value });
    }
    window.dispatchEvent(event);
    return event;
  };

  test('a key runs its command unless that command is off; the uninstaller stops it all', () => {
    const ran: string[] = [];
    const uninstall = installKeymap(
      (command) => () => ran.push(command),
      (command) => command !== 'keep',
    );
    expect(send('keydown', ' ', 'Space').defaultPrevented).toBe(true);
    expect(send('keydown', 's', 'KeyS').defaultPrevented).toBe(false);
    uninstall();
    send('keydown', ' ', 'Space');
    expect(ran).toEqual(['playPause']);
  });

  test('typed into a text field, a key is text; a focused button keeps Space and Enter', () => {
    const ran: string[] = [];
    const uninstall = installKeymap(
      (command) => () => ran.push(command),
      () => true,
    );
    send('keydown', 's', 'KeyS', { target: new TextArea() });
    send('keydown', ' ', 'Space', { target: new Button() });
    send('keydown', 's', 'KeyS', { target: new Button() });
    expect(ran).toEqual(['keep']);
    uninstall();
  });

  test('a held key repeats only commands that repeat; a hold key presses once and releases', () => {
    const ran: string[] = [];
    const uninstall = installKeymap(
      (command) =>
        command === 'skim'
          ? { press: () => ran.push('skim down'), release: () => ran.push('skim up') }
          : () => ran.push(command),
      () => true,
    );
    send('keydown', 'ArrowRight', 'ArrowRight');
    send('keydown', 'ArrowRight', 'ArrowRight', { repeat: true });
    send('keydown', 's', 'KeyS');
    send('keydown', 's', 'KeyS', { repeat: true });
    send('keydown', 'f', 'KeyF');
    send('keydown', 'f', 'KeyF', { repeat: true });
    send('keyup', 'f', 'KeyF');
    expect(ran).toEqual(['forward1', 'forward1', 'keep', 'skim down', 'skim up']);
    // Released when the window loses the focus, as no keyup comes then.
    send('keydown', 'f', 'KeyF');
    window.dispatchEvent(new Event('blur'));
    expect(ran.slice(-2)).toEqual(['skim down', 'skim up']);
    uninstall();
  });
});
