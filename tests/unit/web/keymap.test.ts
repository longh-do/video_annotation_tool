import { describe, expect, test } from 'vitest';
import { BINDINGS, type Chord, chordLabel, IS_MAC, matches } from '../../../src/web/keymap.ts';

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
