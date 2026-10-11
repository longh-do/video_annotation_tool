import { useEffect } from 'react';
import type { QueueItem } from '../../core/api-types.ts';
import { clock } from '../format.ts';

interface QueueOverlayProps {
  readonly recordings: readonly QueueItem[];
  readonly current: string;
  readonly onOpen: (id: string) => void;
  readonly onClose: () => void;
}

const STATUS: Record<QueueItem['status'], string> = {
  not_reviewed: 'to do',
  complete: 'done',
  needs_review: 'needs review',
};

/** Every recording in the batch, to go back to one or pick another. Escape closes. */
export function QueueOverlay({ recordings, current, onOpen, onClose }: QueueOverlayProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay">
      <div className="dialog queue" role="dialog" aria-modal="true" aria-label="Queue">
        <h2>Queue</h2>
        <ol>
          {recordings.map((recording) => (
            <li key={recording.id}>
              <button
                type="button"
                className={`queue-item${recording.id === current ? ' queue-current' : ''}`}
                onClick={() => onOpen(recording.id)}
              >
                <span className="queue-id">{recording.id}</span>
                <span>{clock(recording.durationS)}</span>
                <span className={`queue-status status-${recording.status}`}>
                  {STATUS[recording.status]}
                </span>
                <span>{recording.keepIntervals} kept</span>
              </button>
            </li>
          ))}
        </ol>
        <button type="button" className="close" onClick={onClose}>
          Close (Esc)
        </button>
      </div>
    </div>
  );
}
