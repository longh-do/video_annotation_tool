import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FrameClock } from '../../../src/web/player/frame-clock.ts';
import { frameMap } from '../synthetic.ts';
import { asVideo, FakeVideo, stubBrowser } from './fake-video.ts';

/** Frames at 0, 40, 80, 81 and 200 ms. */
const frames = frameMap(3_000_000_000_000n, [40_000, 40_000, 1_000, 119_000]);

/** What the promise has settled to so far. */
function settled<T>(promise: Promise<T>): { value: T | 'pending' } {
  const state: { value: T | 'pending' } = { value: 'pending' };
  void promise.then((value) => {
    state.value = value;
  });
  return state;
}

describe('frame clock', () => {
  let video: FakeVideo;
  beforeEach(() => {
    vi.useFakeTimers();
    stubBrowser();
    video = new FakeVideo();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('a seek aims 1 ms inside the frame, or half way to a nearer next frame', () => {
    const clock = new FrameClock(asVideo(video), frames);
    expect(clock.seekTime(1)).toBe(0.041);
    expect(clock.seekTime(2)).toBe(0.0805);
    expect(clock.seekTime(4)).toBe(0.201);
  });

  test('the frame on screen comes from the frame callbacks, not from currentTime', () => {
    const clock = new FrameClock(asVideo(video), frames);
    const seen: number[] = [];
    const unsubscribe = clock.subscribe((frame) => seen.push(frame));
    expect(clock.displayed).toBe(-1);
    video.present(0.0805);
    video.present(0.2);
    unsubscribe();
    video.present(0.04);
    expect(seen).toEqual([2, 4]);
    expect(clock.displayed).toBe(1);
    expect(clock.frameAtCurrentTime).toBe(0);
  });

  test('a seek is true once the frame callback shows the frame', async () => {
    video.load();
    const clock = new FrameClock(asVideo(video), frames);
    const seek = clock.seekToFrame(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(await seek).toBe(true);
    expect(video.seeks).toEqual([0.082]);
  });

  test('a seek that shows another frame is tried once more, then is false', async () => {
    video.load();
    const clock = new FrameClock(asVideo(video), frames);
    video.shows = () => 0.04;
    const seek = clock.seekToFrame(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(await seek).toBe(false);
    expect(video.seeks).toEqual([0.082, 0.082]);
  });

  test('a seek waits for the first picture', async () => {
    const clock = new FrameClock(asVideo(video), frames);
    const seek = settled(clock.seekToFrame(2));
    await vi.advanceTimersByTimeAsync(1000);
    expect(video.seeks).toEqual([]);
    video.load();
    await vi.advanceTimersByTimeAsync(1);
    expect(seek.value).toBe(true);
  });

  test('a video that fails to load ends the seeks waiting for it, unanswered', async () => {
    const clock = new FrameClock(asVideo(video), frames);
    const seek = settled(clock.seekToFrame(2));
    video.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(seek.value).toBe(null);
    // Failed before the clock was made: the same, at once.
    const later = new FrameClock(asVideo(video), frames);
    expect(await later.seekToFrame(2)).toBe(null);
    expect(video.seeks).toEqual([]);
  });

  test('a video that has not loaded in 15 s is reported, and a seek waiting on it goes through later', async () => {
    const clock = new FrameClock(asVideo(video), frames);
    const loaded = settled(clock.loaded());
    // E.g. the link a tab was opened at, in the background, where the browser holds media back.
    const seek = settled(clock.seekToFrame(2));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(loaded.value).toBe(false);
    expect(seek.value).toBe('pending');
    video.load();
    await vi.advanceTimersByTimeAsync(1);
    expect(seek.value).toBe(true);
  });
});
