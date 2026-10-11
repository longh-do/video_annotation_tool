import { type ReactNode, useEffect, useId, useRef } from 'react';

export interface BarAction {
  readonly label: string;
  /** What the key is called on screen, e.g. "↵" or "⌘↵". */
  readonly keyLabel: string;
  readonly matches: (event: KeyboardEvent) => boolean;
  readonly run: () => void;
}

interface ConfirmBarProps {
  readonly message: ReactNode;
  /** The first one is the main answer. */
  readonly actions: readonly BarAction[];
  readonly onCancel: () => void;
  /**
   * Keys are ignored this long after the bar appears, so a quick second press of the key that
   * asked (⌘↵ twice) can't answer it unread.
   */
  readonly armMs?: number;
}

/** A question over the bottom of the video: answer with a key or a click, or Escape to go back. */
export function ConfirmBar({ message, actions, onCancel, armMs = 0 }: ConfirmBarProps) {
  const shownAt = useRef(performance.now());
  const messageId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A held key is not an answer either.
      if (event.repeat) return;
      const action = actions.find((a) => a.matches(event));
      if (!action && event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (!action) onCancel();
      else if (performance.now() - shownAt.current >= armMs) action.run();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [actions, onCancel, armMs]);

  return (
    <div className="confirm" role="alertdialog" aria-labelledby={messageId}>
      <div id={messageId} className="confirm-message">
        {message}
      </div>
      {actions.map((action, i) => (
        <button
          key={action.label}
          type="button"
          className={i === 0 ? 'primary' : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={action.run}
        >
          {action.label} <kbd>{action.keyLabel}</kbd>
        </button>
      ))}
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onCancel}>
        Back <kbd>Esc</kbd>
      </button>
    </div>
  );
}
