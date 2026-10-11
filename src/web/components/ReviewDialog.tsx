import { useEffect, useRef, useState } from 'react';
import { REVIEW_REASONS, type ReviewReason } from '../../core/annotation.ts';

/** How each reason reads on screen; its number key is its place in REVIEW_REASONS. */
const REASON_TEXT: Readonly<
  Record<ReviewReason, { readonly label: string; readonly hint: string }>
> = {
  unclear_boundary: { label: 'Unclear boundary', hint: 'say where in the note' },
  unfinished_task: { label: 'Unfinished task', hint: 'the recording ends mid-task' },
  collection_problem: {
    label: 'Collection problem',
    hint: 'frozen camera, desync, wrong procedure, hardware fault: goes back to the collection team',
  },
  other: { label: 'Other', hint: 'explain in the note' },
};
const OPTIONS = REVIEW_REASONS.map((reason) => ({ reason, ...REASON_TEXT[reason] }));

interface ReviewDialogProps {
  readonly onSubmit: (reason: ReviewReason, notes: string) => void;
  readonly onCancel: () => void;
}

/**
 * Q: hand the recording to a reviewer. Press 1–4 for the reason, optionally type a note, Enter to
 * send it on; Escape cancels. The saved note always starts with the reason, so it is never empty.
 * Unlike the menus, a click beside it doesn't close it: that would lose a note being typed.
 */
export function ReviewDialog({ onSubmit, onCancel }: ReviewDialogProps) {
  const [reason, setReason] = useState<ReviewReason | null>(null);
  const [note, setNote] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => dialog.current?.focus(), []);

  const choose = (chosen: ReviewReason) => {
    setReason(chosen);
    input.current?.focus();
  };
  const submit = () => {
    const option = OPTIONS.find((r) => r.reason === reason);
    if (!option) return;
    onSubmit(option.reason, note.trim() ? `${option.label}: ${note.trim()}` : option.label);
  };

  return (
    <div className="overlay">
      <div
        ref={dialog}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Needs review"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          // Enter on a button presses that button; it sends only from the dialog or the note.
          const sends = event.target === dialog.current || event.target === input.current;
          if (event.key === 'Escape') onCancel();
          else if (event.key === 'Enter' && sends) submit();
          else if (event.target !== input.current && /^[1-4]$/.test(event.key)) {
            const option = OPTIONS[Number(event.key) - 1];
            if (option) choose(option.reason);
            event.preventDefault();
          } else return;
          event.stopPropagation();
        }}
      >
        <h2>Needs review — why?</h2>
        {OPTIONS.map((option, i) => (
          <button
            key={option.reason}
            type="button"
            className="reason"
            aria-pressed={option.reason === reason}
            onClick={() => choose(option.reason)}
          >
            <kbd>{i + 1}</kbd> {option.label} <span className="hint">— {option.hint}</span>
          </button>
        ))}
        <input
          ref={input}
          type="text"
          placeholder="Note (optional)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel (Esc)
          </button>
          <button type="button" disabled={reason === null} onClick={submit}>
            Send to review (↵)
          </button>
        </div>
      </div>
    </div>
  );
}
