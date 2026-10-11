import { useEffect, useId, useRef } from 'react';
import { isTyping } from '../keymap.ts';
import { WarningIcon } from './icons.tsx';

export interface BarAction {
  readonly label: string;
  /** What the key is called on screen, e.g. "↵" or "⌘↵". */
  readonly keyLabel: string;
  readonly matches: (event: KeyboardEvent) => boolean;
  readonly run: () => void;
}

interface ConfirmBarProps {
  /** The question, in a few words. */
  readonly title: string;
  /** What to know before answering, one point per line. */
  readonly details: readonly string[];
  /** The first one is the main answer. */
  readonly actions: readonly BarAction[];
  readonly onCancel: () => void;
  /**
   * Keys are ignored this long after the bar appears, so a quick second press of the key that
   * asked (⌘↵ twice) can't answer it unread.
   */
  readonly armMs?: number;
}

/**
 * A question over the bottom of the video: the question, the points behind it, and the answers
 * in one row, the main one last. Answer with a key or a click; Escape goes back.
 */
export function ConfirmBar({ title, details, actions, onCancel, armMs = 0 }: ConfirmBarProps) {
  const shownAt = useRef(performance.now());
  const titleId = useId();
  const detailsId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A held key is not an answer either, nor a key typed into a text field (a task guide).
      if (event.repeat || isTyping(event.target)) return;
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
    <div
      className="confirm"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={details.length > 0 ? detailsId : undefined}
    >
      <p id={titleId} className="confirm-title">
        <WarningIcon />
        {title}
      </p>
      {details.length > 0 && (
        <ul id={detailsId} className="confirm-details">
          {details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <div className="confirm-actions">
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onCancel}>
          Back <kbd>Esc</kbd>
        </button>
        {actions.toReversed().map((action) => (
          <button
            key={action.label}
            type="button"
            className={action === actions[0] ? 'primary' : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={action.run}
          >
            {action.label} <kbd>{action.keyLabel}</kbd>
          </button>
        ))}
      </div>
    </div>
  );
}
