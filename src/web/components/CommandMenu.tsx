import { useEffect, useRef, useState } from 'react';
import { BINDINGS, type Chord, type Command, chordLabel, type Group, matches } from '../keymap.ts';

const GROUPS: readonly Group[] = ['Annotate', 'Navigate', 'Correct', 'Finish'];

interface CommandMenuProps {
  readonly onRun: (command: Command) => void;
  readonly onClose: () => void;
}

/**
 * Every command with its keys, as in the command menus of editors: type to find one, ↑ ↓ to
 * choose, ↵ or a click to run it. ⌘K, Escape or a click beside it closes it. Hold keys (skim)
 * are listed so they can be learned, but only work held.
 */
export function CommandMenu({ onRun, onClose }: CommandMenuProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  // Escape closes it wherever the focus is inside (⌘K and H are commands of their own).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = BINDINGS.filter(
    (b) =>
      b.group !== 'Help' &&
      words.every((word) => `${b.label} ${b.group}`.toLowerCase().includes(word)),
  );
  const runnable = found.filter((b) => !('hold' in b));
  const chosen = runnable[Math.min(active, runnable.length - 1)];
  const list = useRef<HTMLDivElement>(null);
  // The command ↑ ↓ moved to stays in view.
  useEffect(() => {
    list.current?.querySelector('.command-active')?.scrollIntoView({ block: 'nearest' });
  }, [chosen]);
  const run = (command: Command) => {
    onClose();
    onRun(command);
  };

  return (
    <div
      className="overlay overlay-top"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="command-menu" role="dialog" aria-modal="true" aria-label="Command menu">
        <input
          ref={input}
          type="text"
          placeholder="Type to find a command"
          aria-label="Find a command"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            // The search field keeps keys from the shortcuts, so ⌘K is handled here.
            if (matches({ key: 'k', mod: true }, event.nativeEvent)) {
              event.preventDefault();
              onClose();
            } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && chosen) {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : runnable.length - 1;
              setActive((runnable.indexOf(chosen) + step) % runnable.length);
            } else if (event.key === 'Enter' && chosen) {
              event.preventDefault();
              run(chosen.command);
            }
          }}
        />
        <div ref={list} className="command-list">
          {found.length === 0 && <p className="empty">No command matches.</p>}
          {GROUPS.map((group) => {
            const inGroup = found.filter((b) => b.group === group);
            if (inGroup.length === 0) return null;
            return (
              <section key={group} aria-label={group}>
                <h2>{group}</h2>
                {inGroup.map((binding) => {
                  const keys = binding.chords.filter((chord: Chord) => !chord.hidden);
                  const hint = <kbd>{keys.map(chordLabel).join(' or ')}</kbd>;
                  if ('hold' in binding) {
                    return (
                      <p key={binding.command} className="command command-hold">
                        <span>{binding.label}</span>
                        {hint}
                      </p>
                    );
                  }
                  return (
                    <button
                      key={binding.command}
                      type="button"
                      className={`command${binding === chosen ? ' command-active' : ''}`}
                      onMouseMove={() => setActive(runnable.indexOf(binding))}
                      onClick={() => run(binding.command)}
                    >
                      <span>{binding.label}</span>
                      {hint}
                    </button>
                  );
                })}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
