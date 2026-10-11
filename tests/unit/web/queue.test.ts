import { describe, expect, test } from 'vitest';
import type { QueueItem } from '../../../src/core/api-types.ts';
import { nextToAnnotate } from '../../../src/web/queue.ts';

const item = (id: string, status: QueueItem['status']): QueueItem => ({
  id,
  durationS: 60,
  status,
  keepIntervals: 0,
  savedAt: null,
});

describe('queue', () => {
  const queue = [
    item('a', 'complete'),
    item('b', 'not_reviewed'),
    item('c', 'needs_review'),
    item('d', 'not_reviewed'),
  ];

  test('the next recording is the next one not reviewed, wrapping around', () => {
    expect(nextToAnnotate(queue, 'b')).toBe('d');
    expect(nextToAnnotate(queue, 'd')).toBe('b');
    expect(nextToAnnotate(queue, 'a')).toBe('b');
    expect(nextToAnnotate(queue, null)).toBe('b');
  });

  test('none is left once every other recording is done', () => {
    expect(nextToAnnotate([queue[0]!, queue[1]!, queue[2]!], 'b')).toBeNull();
    expect(nextToAnnotate([], null)).toBeNull();
  });
});
