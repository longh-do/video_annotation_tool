import { useEffect, useRef, useState } from 'react';
import type { ReviewReason } from '../../core/annotation.ts';

export const REVIEW_REASONS: readonly {
  readonly reason: ReviewReason;
  readonly label: string;
  readonly hint: string;
}[] = [
  { reason: 'unclear_boundary', label: 'Unclear boundary', hint: 'say where in the note' },
  { reason: 'unfinished_task', label: 'Unfinished task', hint: 'the recording ends mid-task' },
  {
    reason: 'collection_problem',
    label: 'Collection problem',
    hint: 'frozen camera, desync, wrong procedure, hardware fault: goes back to the collection team',
  },
  { reason: 'other', label: 'Other', hint: 'explain in the note' },
];

interface ReviewDialogProps {
  readonly onSubmit: (reason: ReviewReason, notes: string) => void;
  readonly onCancel: () => void;
}

/**
 * Q: hand the recording to a reviewer. Press 1–4 for the reason, optionally type a note, Enter to
 * send it on; Escape cancels. The saved note always starts with the reason, so it is never empty.
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
    const option = REVIEW_REASONS.find((r) => r.reason === reason);
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
          if (event.key === 'Escape') onCancel();
          else if (event.key === 'Enter') submit();
          else if (event.target !== input.current && /^[1-4]$/.test(event.key)) {
            const option = REVIEW_REASONS[Number(event.key) - 1];
            if (option) choose(option.reason);
            event.preventDefault();
          } else return;
          event.stopPropagation();
        }}
      >
        <h2>Needs review — why?</h2>
        {REVIEW_REASONS.map((option, i) => (
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
