/**
 * Keyboard: one table of bindings drives the key handler, the command menu (⌘K) and the key hints
 * on buttons, so they can't disagree. The set is small on purpose: a large shortcut set is what
 * made older annotation tools slow to learn.
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
  /** Works, but isn't listed on screen (e.g. ⇧⌘+ beside ⌘+). */
  readonly hidden?: boolean;
}

export type Group = 'Annotate' | 'Navigate' | 'Correct' | 'Finish' | 'Help';

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
  { command: 'playPause', label: 'Play / pause', group: 'Annotate', chords: [{ code: 'Space' }] },
  {
    command: 'keep',
    label: 'Start here (keep from this frame)',
    group: 'Annotate',
    chords: [{ key: 's' }],
  },
  {
    command: 'cut',
    label: 'Stop here (cut from this frame)',
    group: 'Annotate',
    chords: [{ key: 'd' }],
  },
  {
    command: 'accept',
    label: 'Check: go to the next mark, or accept this one',
    group: 'Annotate',
    chords: [{ code: 'Enter' }, { code: 'NumpadEnter', hidden: true }],
  },
  { command: 'undo', label: 'Undo', group: 'Annotate', chords: [{ key: 'z', mod: true }] },
  {
    command: 'redo',
    label: 'Redo',
    group: 'Annotate',
    chords: [{ key: 'z', mod: true, shift: true }],
  },
  {
    command: 'submit',
    label: 'Submit, open the next recording',
    group: 'Finish',
    chords: [
      { code: 'Enter', mod: true },
      { code: 'NumpadEnter', mod: true, hidden: true },
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
  {
    command: 'skim',
    label: 'Hold: skim at 6×',
    group: 'Navigate',
    chords: [{ key: 'f' }],
    hold: true,
  },
  {
    command: 'previousBoundary',
    label: 'Previous boundary',
    group: 'Navigate',
    chords: [{ code: 'BracketLeft' }],
  },
  {
    command: 'nextBoundary',
    label: 'Next boundary',
    group: 'Navigate',
    chords: [{ code: 'BracketRight' }],
  },
  {
    command: 'zoomIn',
    label: 'Zoom the timeline in',
    group: 'Navigate',
    chords: [
      { code: 'Equal', mod: true },
      { code: 'Equal', mod: true, shift: true, hidden: true },
      { code: 'NumpadAdd', mod: true, hidden: true },
    ],
    repeat: true,
  },
  {
    command: 'zoomOut',
    label: 'Zoom the timeline out',
    group: 'Navigate',
    chords: [
      { code: 'Minus', mod: true },
      { code: 'NumpadSubtract', mod: true, hidden: true },
    ],
    repeat: true,
  },
  {
    command: 'zoomFit',
    label: 'Show the whole recording',
    group: 'Navigate',
    chords: [{ code: 'Digit0', mod: true }],
  },
  {
    command: 'nudgeBack1',
    label: 'Move the selected boundary 1 frame earlier',
    group: 'Correct',
    chords: [{ code: 'Comma' }],
    repeat: true,
  },
  {
    command: 'nudgeForward1',
    label: 'Move the selected boundary 1 frame later',
    group: 'Correct',
    chords: [{ code: 'Period' }],
    repeat: true,
  },
  {
    command: 'nudgeBack10',
    label: 'Move the selected boundary 10 frames earlier',
    group: 'Correct',
    chords: [{ code: 'Comma', shift: true }],
    repeat: true,
  },
  {
    command: 'nudgeForward10',
    label: 'Move the selected boundary 10 frames later',
    group: 'Correct',
    chords: [{ code: 'Period', shift: true }],
    repeat: true,
  },
  {
    command: 'deleteSelected',
    label: 'Delete the selected interval or boundary',
    group: 'Correct',
    chords: [{ code: 'Backspace' }, { code: 'Delete' }],
  },
  { command: 'noTask', label: 'No useful task…', group: 'Finish', chords: [{ key: 'n' }] },
  { command: 'needsReview', label: 'Needs review…', group: 'Finish', chords: [{ key: 'q' }] },
  {
    command: 'help',
    label: 'Command menu',
    group: 'Help',
    chords: [{ key: 'k', mod: true }, { key: 'h' }],
  },
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
 * (e.g. only the command menu's own keys while it is open). Returns the uninstaller.
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
  Equal: '+',
  Minus: '−',
};

/** The keys of a command as listed on screen, e.g. "⌘K or H". */
export function keysOf(command: Command): string {
  const binding: Binding | undefined = BINDINGS.find((b) => b.command === command);
  return (binding?.chords ?? [])
    .filter((chord) => !chord.hidden)
    .map(chordLabel)
    .join(' or ');
}

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
