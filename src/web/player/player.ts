/**
 * Playback of the reference video: play, pause, step, seek, speed and hold-to-skim, on top of
 * FrameClock and SeekQueue. React reads it through `subscribe` and `snapshot`
 * (useSyncExternalStore); the snapshot changes with every presented frame.
 */
import { displayedFrame, type FrameMap, frameCount } from '../../core/frame-map.ts';
import { FrameClock, type SeekResult } from './frame-clock.ts';
import { SeekQueue } from './seek-queue.ts';

/** Marking speeds (keys 1–4). Faster than 2.5× hurts accuracy, so marking never goes there. */
export const SPEEDS = [1, 1.5, 2, 2.5] as const;
export const DEFAULT_SPEED = 2;
/** Hold F to skim obvious downtime. */
export const SKIM_SPEED = 4;
/** After pause() the picture keeps moving for a moment; wait before snapping to it. */
const PAUSE_SETTLE_MS = 80;

export interface PlayerSnapshot {
  /** The frame on screen; -1 until the first one is presented. */
  readonly frame: number;
  readonly playing: boolean;
  /** The marking speed; skimming overrides it while F is held. */
  readonly speed: number;
  readonly skimming: boolean;
  /** A paused seek could not be verified: the screen may not show the frame a mark would save. */
  readonly seekFailed: boolean;
}

export class Player {
  readonly clock: FrameClock;
  readonly #video: HTMLVideoElement;
  readonly #frames: FrameMap;
  readonly #queue: SeekQueue;
  readonly #listeners = new Set<() => void>();
  readonly #disposers: (() => void)[] = [];
  #snapshot: PlayerSnapshot;
  /** Counts seek requests, so a pause snap can tell that a newer seek has overtaken it. */
  #seeks = 0;

  constructor(video: HTMLVideoElement, frames: FrameMap, speed: number) {
    this.#video = video;
    this.#frames = frames;
    this.clock = new FrameClock(video, frames);
    this.#queue = new SeekQueue(this.clock, (_frame, result) => this.#onSeekSettled(result));
    this.#snapshot = { frame: -1, playing: false, speed, skimming: false, seekFailed: false };
    video.playbackRate = speed;

    this.#disposers.push(this.clock.subscribe((frame) => this.#update({ frame })));
    // During playback the frame callbacks name the frames; a failed paused seek no longer matters.
    const onPlay = () => this.#update({ playing: true, seekFailed: false });
    const onPause = () => this.#update({ playing: false });
    const onVisible = () => {
      // Frame callbacks stop while the page is hidden; make sure the picture and state agree.
      if (document.visibilityState === 'visible' && video.paused) this.#snapToScreen();
    };
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    document.addEventListener('visibilitychange', onVisible);
    this.#disposers.push(() => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      document.removeEventListener('visibilitychange', onVisible);
      this.clock.dispose();
    });
  }

  get snapshot(): PlayerSnapshot {
    return this.#snapshot;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get lastFrame(): number {
    return frameCount(this.#frames) - 1;
  }

  /**
   * The frame the annotator is looking at: during playback the last one presented; when paused,
   * the one a pending seek is about to show (so S right after → marks the new frame).
   */
  get frame(): number {
    return this.#video.paused ? this.#queue.target : this.clock.displayed;
  }

  /** Plays from here; at the end, stays there rather than starting over. */
  play(): void {
    if (!this.#video.ended) void this.#video.play();
  }

  /** Pauses, then puts `currentTime` on the frame actually on screen (unless a seek came first). */
  async pause(): Promise<void> {
    if (this.#video.paused) return;
    this.#video.pause();
    const seeks = this.#seeks;
    await new Promise((resolve) => setTimeout(resolve, PAUSE_SETTLE_MS));
    if (this.#video.paused && this.#seeks === seeks) this.#snapToScreen();
  }

  togglePlay(): void {
    if (this.#video.paused) this.play();
    else void this.pause();
  }

  /** ← / →: pause and step `delta` frames from where the video is heading. */
  async step(delta: number): Promise<void> {
    await this.pause();
    this.seek(this.#queue.target + delta);
  }

  /** Pause and show `frame` exactly. */
  seek(frame: number): void {
    this.#seeks++;
    if (!this.#video.paused) this.#video.pause();
    this.#queue.request(Math.min(Math.max(frame, 0), this.lastFrame));
  }

  /** A: jump back a little; keeps playing if it was. */
  rewind(seconds: number): void {
    const from = this.#frames.ptsUs[Math.max(this.frame, 0)] ?? 0;
    const frame = Math.max(displayedFrame(this.#frames, 0, from / 1e6 - seconds), 0);
    if (this.#video.paused) this.seek(frame);
    else this.#video.currentTime = this.clock.seekTime(frame);
  }

  setSpeed(speed: number): void {
    if (!this.#snapshot.skimming) this.#video.playbackRate = speed;
    this.#update({ speed });
  }

  /** Hold F: play at skim speed; on release, carry on at the marking speed. */
  skim(on: boolean): void {
    if (on === this.#snapshot.skimming) return;
    this.#video.playbackRate = on ? SKIM_SPEED : this.#snapshot.speed;
    if (on) this.play();
    this.#update({ skimming: on });
  }

  dispose(): void {
    for (const dispose of this.#disposers) dispose();
    this.#listeners.clear();
  }

  #snapToScreen(): void {
    this.#queue.request(Math.max(this.clock.frameAtCurrentTime, this.clock.displayed, 0));
  }

  #onSeekSettled(result: SeekResult): void {
    // Seeks can't be verified while playing; playback resumed before this one settled.
    if (!this.#video.paused) return;
    this.#update({ seekFailed: result !== true });
  }

  #update(change: Partial<PlayerSnapshot>): void {
    const next = { ...this.#snapshot, ...change };
    const keys = Object.keys(change) as (keyof PlayerSnapshot)[];
    if (keys.every((key) => next[key] === this.#snapshot[key])) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}
