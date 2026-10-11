import { useEffect } from 'react';

interface ConfirmBarProps {
  readonly message: string;
  /** What the confirming key is called, e.g. "↵" or "⌘↵". */
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** Whether a key press confirms. Defaults to Enter. */
  readonly confirms?: (event: KeyboardEvent) => boolean;
}

/** A one-line question over the video: confirm with a key, or Escape to go back. */
export function ConfirmBar({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  confirms,
}: ConfirmBarProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const isConfirm = confirms
        ? confirms(event)
        : event.key === 'Enter' && !event.metaKey && !event.ctrlKey;
      if (!isConfirm && event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (isConfirm) onConfirm();
      else onCancel();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [confirms, onConfirm, onCancel]);

  return (
    <div className="confirm" role="alertdialog" aria-label={message}>
      <span>{message}</span>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onConfirm}>
        Confirm ({confirmLabel})
      </button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onCancel}>
        Back (Esc)
      </button>
    </div>
  );
}
