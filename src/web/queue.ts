/** Queue order: which recording comes next. */
import type { QueueItem } from '../core/api-types.ts';

/**
 * The next recording to annotate after `current`: the first one not reviewed yet, going on from
 * `current` in queue order and wrapping around; null when every other one is done.
 */
export function nextToAnnotate(
  recordings: readonly QueueItem[],
  current: string | null,
): string | null {
  const at = recordings.findIndex((r) => r.id === current);
  const order = [...recordings.slice(at + 1), ...recordings.slice(0, Math.max(at, 0))];
  return order.find((r) => r.status === 'not_reviewed')?.id ?? null;
}
