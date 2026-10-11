/**
 * Keyboard: one table of bindings drives the key handler, the legend that is always on screen and
 * the help overlay, so they can't disagree. The set is small on purpose: a large shortcut set is
 * what made older annotation tools slow to learn.
 *
 * Letters follow the active keyboard layout (S is S on AZERTY too). Digits, punctuation and arrows
 * use the physical key, so Shift+, still means "nudge 10" whatever symbol the layout prints.
 */

export interface Chord {
  /** A letter, matched on the active layout. */
  readonly key?: string;
  /** A physical key (`KeyboardEvent.code`). */
  readonly code?: string;
  /** ⌘ on macOS, Ctrl elsewhere. */
  readonly mod?: boolean;
  readonly shift?: boolean;
}

export type Group = 'Core' | 'Navigate' | 'Correct' | 'Outcome' | 'Help';

export interface Binding {
  readonly command: string;
  readonly label: string;
  readonly group: Group;
  /** Alternatives; the first one is shown. */
  readonly chords: readonly Chord[];
  /** Keep firing while the key auto-repeats (stepping, nudging). */
  readonly repeat?: boolean;
  /** Fires on press and again on release (hold to skim). */
  readonly hold?: boolean;
}

export const BINDINGS = [
  { command: 'playPause', label: 'Play / pause', group: 'Core', chords: [{ code: 'Space' }] },
  { command: 'keep', label: 'Keep from here', group: 'Core', chords: [{ key: 's' }] },
  { command: 'cut', label: 'Cut from here', group: 'Core', chords: [{ key: 'd' }] },
  {
    command: 'accept',
    label: 'Check: accept, go to next',
    group: 'Core',
    chords: [{ code: 'Enter' }, { code: 'NumpadEnter' }],
  },
  { command: 'undo', label: 'Undo', group: 'Core', chords: [{ key: 'z', mod: true }] },
  { command: 'redo', label: 'Redo', group: 'Core', chords: [{ key: 'z', mod: true, shift: true }] },
  {
    command: 'submit',
    label: 'Submit, open next',
    group: 'Core',
    chords: [
      { code: 'Enter', mod: true },
      { code: 'NumpadEnter', mod: true },
    ],
  },
  {
    command: 'back1',
    label: 'Back 1 frame',
    group: 'Navigate',
    chords: [{ code: 'ArrowLeft' }],
    repeat: true,
  },
  {
    command: 'forward1',
    label: 'Forward 1 frame',
    group: 'Navigate',
    chords: [{ code: 'ArrowRight' }],
    repeat: true,
  },
  {
    command: 'back10',
    label: 'Back 10 frames',
    group: 'Navigate',
    chords: [{ code: 'ArrowLeft', shift: true }],
    repeat: true,
  },
  {
    command: 'forward10',
    label: 'Forward 10 frames',
    group: 'Navigate',
    chords: [{ code: 'ArrowRight', shift: true }],
    repeat: true,
  },
  { command: 'rewind', label: 'Back 2 s', group: 'Navigate', chords: [{ key: 'a' }] },
  { command: 'speed1', label: 'Speed 1×', group: 'Navigate', chords: [{ code: 'Digit1' }] },
  { command: 'speed2', label: 'Speed 1.5×', group: 'Navigate', chords: [{ code: 'Digit2' }] },
  { command: 'speed3', label: 'Speed 2×', group: 'Navigate', chords: [{ code: 'Digit3' }] },
  { command: 'speed4', label: 'Speed 2.5×', group: 'Navigate', chords: [{ code: 'Digit4' }] },
  {
    command: 'skim',
    label: 'Hold: skim at 4×',
    group: 'Navigate',
    chords: [{ key: 'f' }],
    hold: true,
  },
  {
    command: 'previousBoundary',
    label: 'Previous boundary',
    group: 'Navigate',
    chords: [{ code: 'BracketLeft' }, { code: 'Tab', shift: true }],
  },
  {
    command: 'nextBoundary',
    label: 'Next boundary',
    group: 'Navigate',
    chords: [{ code: 'BracketRight' }, { code: 'Tab' }],
  },
  {
    command: 'nudgeBack1',
    label: 'Nudge boundary −1 frame',
    group: 'Correct',
    chords: [{ code: 'Comma' }],
    repeat: true,
  },
  {
    command: 'nudgeForward1',
    label: 'Nudge boundary +1 frame',
    group: 'Correct',
    chords: [{ code: 'Period' }],
    repeat: true,
  },
  {
    command: 'nudgeBack10',
    label: 'Nudge boundary −10 frames',
    group: 'Correct',
    chords: [{ code: 'Comma', shift: true }],
    repeat: true,
  },
  {
    command: 'nudgeForward10',
    label: 'Nudge boundary +10 frames',
    group: 'Correct',
    chords: [{ code: 'Period', shift: true }],
    repeat: true,
  },
  {
    command: 'moveHere',
    label: 'Move nearest boundary here',
    group: 'Correct',
    chords: [{ key: 't' }],
  },
  { command: 'flip', label: 'Flip keep/cut here', group: 'Correct', chords: [{ key: 'x' }] },
  {
    command: 'deleteBoundary',
    label: 'Delete boundary',
    group: 'Correct',
    chords: [{ code: 'Backspace' }, { code: 'Delete' }],
  },
  {
    command: 'playAround',
    label: 'Play around boundary',
    group: 'Correct',
    chords: [{ code: 'Slash' }],
  },
  { command: 'noTask', label: 'No useful task', group: 'Outcome', chords: [{ key: 'n' }] },
  { command: 'needsReview', label: 'Needs review…', group: 'Outcome', chords: [{ key: 'q' }] },
  { command: 'help', label: 'All keys', group: 'Help', chords: [{ key: 'h' }] },
] as const satisfies readonly Binding[];

export type Command = (typeof BINDINGS)[number]['command'];

/** What a key does: a plain action, or press/release for hold keys. */
export type KeyHandler =
  | (() => void)
  | { readonly press: () => void; readonly release: () => void };

const platform =
  (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ??
  navigator.platform;
export const IS_MAC = /mac/i.test(platform);

/**
 * Installs one capture-phase key listener for the whole page. `handlerFor` is asked at each key
 * press, so handlers always see current state; `enabled` says which commands apply right now
 * (e.g. only H while the help overlay is open). Returns the uninstaller.
 */
export function installKeymap(
  handlerFor: (command: Command) => KeyHandler,
  enabled: (command: Command) => boolean,
): () => void {
  const held = new Map<string, () => void>();
  const releaseAll = () => {
    for (const release of held.values()) release();
    held.clear();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || isTyping(event.target)) return;
    const binding = BINDINGS.find((b) => b.chords.some((chord) => matches(chord, event)));
    if (!binding || !enabled(binding.command) || nativeOwnsKey(event.target, event)) return;
    event.preventDefault();
    if (event.repeat && !('repeat' in binding)) return;
    const handler = handlerFor(binding.command);
    if (typeof handler === 'function') handler();
    else if (!held.has(event.code)) {
      held.set(event.code, handler.release);
      handler.press();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    const release = held.get(event.code);
    if (!release) return;
    held.delete(event.code);
    release();
  };

  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('keyup', onKeyUp, { capture: true });
  // A key released while the window is in the background never reports its keyup.
  window.addEventListener('blur', releaseAll);
  return () => {
    releaseAll();
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    window.removeEventListener('keyup', onKeyUp, { capture: true });
    window.removeEventListener('blur', releaseAll);
  };
}

export function matches(chord: Chord, event: KeyboardEvent): boolean {
  const mod = IS_MAC ? event.metaKey : event.ctrlKey;
  const otherMod = IS_MAC ? event.ctrlKey : event.metaKey;
  if (Boolean(chord.mod) !== mod || otherMod || event.altKey) return false;
  if (Boolean(chord.shift) !== event.shiftKey) return false;
  if (chord.code !== undefined) return event.code === chord.code;
  // A letter: follow the layout, but fall back to the physical key on layouts without Latin letters.
  const key = event.key.toLowerCase();
  return (
    key === chord.key || (!/^[a-z]$/.test(key) && event.code === `Key${chord.key?.toUpperCase()}`)
  );
}

const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Enter: '↵',
  NumpadEnter: '↵',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backspace: '⌫',
  Delete: 'Del',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Tab: 'Tab',
};

/** How a chord is written on screen: ⇧⌘Z on macOS, Shift+Ctrl+Z elsewhere. */
export function chordLabel(chord: Chord): string {
  const key =
    chord.key?.toUpperCase() ??
    KEY_NAMES[chord.code ?? ''] ??
    chord.code?.replace(/^Digit/, '') ??
    '';
  const shift = chord.shift ? (IS_MAC ? '⇧' : 'Shift+') : '';
  const mod = chord.mod ? (IS_MAC ? '⌘' : 'Ctrl+') : '';
  return `${shift}${mod}${key}`;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  return (
    target instanceof HTMLInputElement &&
    !['checkbox', 'radio', 'range', 'button'].includes(target.type)
  );
}

/** A focused button owns Space and Enter; let it act instead of the shortcut. */
function nativeOwnsKey(target: EventTarget | null, event: KeyboardEvent): boolean {
  const activatable = target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement;
  return (
    activatable &&
    (event.code === 'Space' || event.code === 'Enter') &&
    !event.metaKey &&
    !event.ctrlKey
  );
}
