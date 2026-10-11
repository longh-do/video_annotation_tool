import { expect, test } from 'vitest';
import type { FrameClock } from '../../../src/web/player/frame-clock.ts';
import { SeekQueue } from '../../../src/web/player/seek-queue.ts';

/** A clock whose seeks finish when the test says so. */
function fakeClock() {
  const seeks: number[] = [];
  const pending: (() => void)[] = [];
  const clock = {
    displayed: 10,
    seekToFrame(k: number) {
      seeks.push(k);
      return new Promise<boolean>((resolve) =>
        pending.push(() => {
          clock.displayed = k;
          resolve(true);
        }),
      );
    },
  };
  const finish = async () => {
    pending.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { clock: clock as unknown as FrameClock, seeks, finish };
}

test('one seek in flight; the newest request wins and is the only one reported', async () => {
  const { clock, seeks, finish } = fakeClock();
  const settled: number[] = [];
  const queue = new SeekQueue(clock, (frame) => settled.push(frame));
  expect(queue.target).toBe(10);
  queue.request(11);
  queue.request(12);
  queue.request(13);
  expect(queue.target).toBe(13);
  await finish();
  await finish();
  expect(seeks).toEqual([11, 13]);
  expect(settled).toEqual([13]);
  expect(queue.target).toBe(13);
});

test('stepping from the target makes quick presses add up', async () => {
  const { clock, seeks, finish } = fakeClock();
  const queue = new SeekQueue(clock, () => {});
  for (let i = 0; i < 5; i++) queue.request(queue.target + 1);
  await finish();
  await finish();
  expect(seeks.at(-1)).toBe(15);
});

test('when playback takes over, requests not started yet are dropped', async () => {
  const { clock, seeks, finish } = fakeClock();
  const queue = new SeekQueue(clock, () => {});
  queue.request(11);
  queue.request(14);
  queue.cancel();
  await finish();
  await finish();
  expect(seeks).toEqual([11]);
});
