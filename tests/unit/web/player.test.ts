import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Player } from '../../../src/web/player/player.ts';
import { frameMap } from '../synthetic.ts';
import { asVideo, FakeVideo, stubBrowser } from './fake-video.ts';

/** 21 frames, 40 ms apart. */
const frames = frameMap(3_000_000_000_000n, Array<number>(20).fill(40_000));

describe('player', () => {
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

  test('quick steps add up, and the frame shown is the frame marked', async () => {
    video.load();
    const player = new Player(asVideo(video), frames, 2);
    video.present(0);
    for (let i = 0; i < 5; i++) void player.step(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(player.frame).toBe(5);
    await vi.advanceTimersByTimeAsync(10);
    expect(player.snapshot).toMatchObject({ frame: 5, playing: false, seekFailed: false });
  });

  test('pausing puts the video on the frame on screen', async () => {
    video.load();
    const player = new Player(asVideo(video), frames, 2);
    player.play();
    video.present(0.2);
    video.present(0.24);
    expect(player.snapshot).toMatchObject({ frame: 6, playing: true });
    const paused = player.pause();
    await vi.advanceTimersByTimeAsync(100);
    await paused;
    expect(video.seeks).toEqual([0.241]);
    expect(player.snapshot).toMatchObject({ frame: 6, playing: false, seekFailed: false });
  });

  test('a seek that cannot be confirmed turns marking off until one is', async () => {
    video.load();
    const player = new Player(asVideo(video), frames, 2);
    video.shows = () => null;
    player.seek(3);
    await vi.advanceTimersByTimeAsync(1100);
    expect(player.snapshot.seekFailed).toBe(true);
    video.shows = (seconds) => seconds;
    player.seek(4);
    await vi.advanceTimersByTimeAsync(10);
    expect(player.snapshot).toMatchObject({ frame: 4, seekFailed: false });
  });

  test('a video that fails to load turns marking off, with a seek waiting on it', async () => {
    const player = new Player(asVideo(video), frames, 2);
    player.seek(3);
    expect(player.frame).toBe(3);
    video.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(player.snapshot.seekFailed).toBe(true);
    // play() is refused (and handled); marking stays off.
    player.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(player.snapshot).toMatchObject({ playing: false, seekFailed: true });
  });

  test('a video that has not loaded in 15 s turns marking off until it loads and a seek lands', async () => {
    const player = new Player(asVideo(video), frames, 2);
    player.seek(2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(player.snapshot.seekFailed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(player.snapshot.seekFailed).toBe(true);
    video.load();
    await vi.advanceTimersByTimeAsync(5);
    expect(player.snapshot).toMatchObject({ seekFailed: false, frame: 2 });
  });

  test('after the video breaks, playing does not turn marking back on', () => {
    video.load();
    const player = new Player(asVideo(video), frames, 2);
    video.fail(2);
    expect(player.snapshot.seekFailed).toBe(true);
    player.play();
    expect(player.snapshot).toMatchObject({ playing: true, seekFailed: true });
  });

  test('a play() the browser refuses is handled', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    video.load();
    video.play = () => Promise.reject(new DOMException('interrupted by pause()', 'AbortError'));
    const player = new Player(asVideo(video), frames, 2);
    player.play();
    await vi.advanceTimersByTimeAsync(0);
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  test('the speed sets the playback rate; holding F skims, then goes back to it', () => {
    video.load();
    const player = new Player(asVideo(video), frames, 2);
    expect(video.playbackRate).toBe(2);
    player.setSpeed(0.5);
    player.skim(true);
    expect(video.playbackRate).toBe(6);
    expect(player.snapshot).toMatchObject({ speed: 0.5, skimming: true, playing: true });
    player.skim(false);
    expect(video.playbackRate).toBe(0.5);
  });
});
