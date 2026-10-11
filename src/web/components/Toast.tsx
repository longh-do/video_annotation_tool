import { useEffect } from 'react';

export interface ToastMessage {
  readonly text: string;
  /** One follow-up, e.g. undoing what was just done. */
  readonly action?: {
    readonly label: string;
    /** The key that does the same. */
    readonly keys?: string;
    readonly run: () => void;
  };
  /**
   * Closes the message early, e.g. once its Undo would undo something else. Gets the closing
   * function and returns what stops listening.
   */
  readonly closeWhen?: (close: () => void) => () => void;
}

const SHOWN_MS = 6000;

/** A short message at the top of the screen, clear of the timeline, that goes away by itself. */
export function Toast({
  message,
  onClose,
}: {
  readonly message: ToastMessage;
  readonly onClose: () => void;
}) {
  // A new message shows for the full time again.
  useEffect(() => {
    const timer = setTimeout(onClose, SHOWN_MS);
    return () => clearTimeout(timer);
  }, [message, onClose]);
  useEffect(() => message.closeWhen?.(onClose), [message, onClose]);
  const { action } = message;
  return (
    <div className="toast" role="status">
      <span className="toast-text">{message.text}</span>
      {action && (
        <button
          type="button"
          className="toast-action"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onClose();
            action.run();
          }}
        >
          {action.label}
          {action.keys && <kbd>{action.keys}</kbd>}
        </button>
      )}
      <button
        type="button"
        className="toast-close"
        aria-label="Close the message"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
