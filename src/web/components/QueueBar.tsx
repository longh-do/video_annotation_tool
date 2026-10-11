interface QueueBarProps {
  /** 1-based place of the open recording in the queue. */
  readonly position: number;
  readonly total: number;
  /** The next recording to annotate: fetched and ready, still loading, or none left. */
  readonly next: 'ready' | 'loading' | 'none';
  readonly onOpenQueue: () => void;
}

const NEXT = { ready: 'next ready', loading: 'loading next…', none: 'no other to do' } as const;

/** Where the annotator is in the batch, and whether the next recording is ready to open. */
export function QueueBar({ position, total, next, onOpenQueue }: QueueBarProps) {
  return (
    <span className="queue-bar">
      Recording {position} of {total} · {NEXT[next]}
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onOpenQueue}>
        Queue
      </button>
    </span>
  );
}
