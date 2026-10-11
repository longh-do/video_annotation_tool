import { useEffect } from 'react';
import { BINDINGS, type Command, chordLabel, type Group } from '../keymap.ts';

/** The keys a new annotator needs on day one; everything else is under H. */
const DAY_ONE: readonly Command[] = [
  'playPause',
  'keep',
  'cut',
  'accept',
  'undo',
  'submit',
  'help',
];
const GROUPS: readonly Group[] = ['Core', 'Navigate', 'Correct', 'Outcome', 'Help'];

function bindingOf(command: Command) {
  const binding = BINDINGS.find((b) => b.command === command);
  if (!binding) throw new Error(`no binding for ${command}`);
  return binding;
}

/** Always on screen: the core keys, each a button that does what the key does. */
export function KeyLegend({ onRun }: { readonly onRun: (command: Command) => void }) {
  return (
    <footer className="legend">
      {DAY_ONE.map((command) => {
        const binding = bindingOf(command);
        return (
          <button
            key={command}
            type="button"
            className="key-button"
            // Buttons never take focus, so Space and Enter always reach the shortcuts.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onRun(command)}
          >
            <kbd>{chordLabel(binding.chords[0])}</kbd>
            {binding.label}
          </button>
        );
      })}
    </footer>
  );
}

interface HelpOverlayProps {
  readonly onRun: (command: Command) => void;
  readonly onClose: () => void;
}

/** Every key, grouped, from the same table that drives the keyboard. H or Escape closes it. */
export function HelpOverlay({ onRun, onClose }: HelpOverlayProps) {
  // H is a keymap command (it toggles); Escape is handled here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay">
      <div className="help" role="dialog" aria-modal="true" aria-label="All keys">
        {GROUPS.map((group) => (
          <section key={group}>
            <h2>{group}</h2>
            {BINDINGS.filter((b) => b.group === group).map((binding) => {
              const keys = <kbd>{binding.chords.map(chordLabel).join(' or ')}</kbd>;
              // A hold key has nothing to click: it acts only while held.
              if ('hold' in binding) {
                return (
                  <p key={binding.command} className="key-row">
                    {keys}
                    {binding.label}
                  </p>
                );
              }
              return (
                <button
                  key={binding.command}
                  type="button"
                  className="key-row"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onRun(binding.command)}
                >
                  {keys}
                  {binding.label}
                </button>
              );
            })}
          </section>
        ))}
        <button type="button" className="close" onClick={onClose}>
          Close (H)
        </button>
      </div>
    </div>
  );
}
