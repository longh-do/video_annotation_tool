import { useEffect } from 'react';

export interface ToastMessage {
  readonly text: string;
  /** One follow-up, e.g. undoing what was just done. */
  readonly action?: { readonly label: string; readonly run: () => void };
}

const SHOWN_MS = 8000;

/** A short message at the bottom of the screen that goes away by itself. */
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
  const { action } = message;
  return (
    <div className="toast" role="status">
      <span>{message.text}</span>
      {action && (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onClose();
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
