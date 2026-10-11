import { ListIcon } from './icons.tsx';

interface QueueBarProps {
  /** 1-based place of the open recording in the queue. */
  readonly position: number;
  readonly total: number;
  /** The next recording to annotate: fetched and ready, still loading, or none left. */
  readonly next: 'ready' | 'loading' | 'none';
  readonly onOpenQueue: () => void;
}

const NEXT = {
  ready: 'the next one is ready',
  loading: 'loading the next one',
  none: 'no other to do',
} as const;

/** Where the annotator is in the batch; a click lists every recording. */
export function QueueBar({ position, total, next, onOpenQueue }: QueueBarProps) {
  return (
    <button
      type="button"
      className="queue-bar"
      data-next={next}
      aria-label={`Queue: recording ${position} of ${total}`}
      title={`Recording ${position} of ${total} (${NEXT[next]}). Click for the list.`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpenQueue}
    >
      <ListIcon />
      {position} / {total}
    </button>
  );
}
