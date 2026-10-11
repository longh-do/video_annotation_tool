/**
 * Which frame is on screen, and how to put frame k there.
 *
 * `requestVideoFrameCallback` reports each frame the browser presents, with its exact media time.
 * Mapped through the frames CSV, that is the only source of "the frame on screen". `currentTime`
 * is not: during playback it trails the picture by a frame or two.
 *
 * Seeking to a frame's exact presentation time is unreliable: Chrome truncates seek times to whole
 * microseconds and shows the previous frame for about 2% of frames. Seeks therefore aim a little
 * inside the frame, at PTS + min(1 ms, half the gap to the next frame), and every seek is checked
 * against the frame callback that follows it.
 *
 * Chrome and Edge only (the app gates other browsers); the video must start at time 0.
 */
import { displayedFrame, type FrameMap } from '../../core/frame-map.ts';

/** True: the frame is on screen. False: another frame is. Null: the browser gave no sign. */
export type SeekResult = boolean | null;

/** The first picture can take seconds over a slow connection; one this late counts as failed. */
const LOAD_TIMEOUT_MS = 15_000;
/** A far seek over a slow connection can take seconds before the video has the data. */
const SEEKED_TIMEOUT_MS = 15_000;
/** Once seeked, the frame callback comes within a frame or two. */
const PRESENT_TIMEOUT_MS = 500;
/** Seeking within the frame already shown may present nothing new, so wait less for it. */
const SAME_FRAME_TIMEOUT_MS = 150;

export class FrameClock {
  readonly #video: HTMLVideoElement;
  readonly #frames: FrameMap;
  readonly #loaded: Promise<boolean>;
  #displayed = -1;
  #waiters: ((frame: number) => void)[] = [];
  readonly #listeners = new Set<(frame: number) => void>();
  #callbackId = 0;

  constructor(video: HTMLVideoElement, frames: FrameMap) {
    if (frames.parts.length !== 1 || frames.ptsUs[0] !== 0) {
      throw new Error('the player needs a single-part video whose first frame is at time 0');
    }
    this.#video = video;
    this.#frames = frames;
    this.#loaded = firstPicture(video);
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      this.#displayed = displayedFrame(frames, 0, metadata.mediaTime);
      for (const resolve of this.#waiters.splice(0)) resolve(this.#displayed);
      for (const listener of this.#listeners) listener(this.#displayed);
      this.#callbackId = video.requestVideoFrameCallback(onFrame);
    };
    this.#callbackId = video.requestVideoFrameCallback(onFrame);
  }

  /** The frame on screen, from the last frame callback; -1 before the first one. */
  get displayed(): number {
    return this.#displayed;
  }

  /** The frame `currentTime` points into; behind the picture during playback. */
  get frameAtCurrentTime(): number {
    return displayedFrame(this.#frames, 0, this.#video.currentTime);
  }

  /** Calls `listener` with each presented frame; returns the unsubscribe function. */
  subscribe(listener: (frame: number) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Where to seek, in seconds, to show frame `k`. */
  seekTime(k: number): number {
    const pts = this.#frames.ptsUs;
    const start = pts[k];
    if (start === undefined) throw new RangeError(`no frame ${k}`);
    const gap = (pts[k + 1] ?? start + 2000) - start;
    return (start + Math.min(1000, Math.floor(gap / 2))) / 1e6;
  }

  /**
   * True once the video has a picture; false if it failed to load or still has none after
   * LOAD_TIMEOUT_MS (a later call can still find it loaded).
   */
  async loaded(): Promise<boolean> {
    return (await within(this.#loaded, LOAD_TIMEOUT_MS)) === true;
  }

  /**
   * Shows frame `k` and resolves once the browser has presented it. Paused only: it retries once,
   * unless playback started meanwhile (a retry would yank the playing video back). Null, without
   * seeking, when the video has not loaded.
   */
  async seekToFrame(k: number): Promise<SeekResult> {
    if (!(await this.loaded())) return null;
    const first = await this.#seekOnce(k);
    return first === true || !this.#video.paused ? first : this.#seekOnce(k);
  }

  dispose(): void {
    this.#video.cancelVideoFrameCallback(this.#callbackId);
    this.#listeners.clear();
  }

  async #seekOnce(k: number): Promise<SeekResult> {
    const target = this.seekTime(k);
    const alreadyShown = this.#displayed === k;
    if (alreadyShown && Math.abs(this.#video.currentTime - target) < 2e-6) return true;
    const shown = await this.#seekTo(
      target,
      alreadyShown ? SAME_FRAME_TIMEOUT_MS : PRESENT_TIMEOUT_MS,
    );
    if (shown === null) return alreadyShown ? true : null;
    return shown === k;
  }

  /** Seeks and resolves with the frame presented next, or null if none came in time. */
  async #seekTo(seconds: number, presentTimeoutMs: number): Promise<number | null> {
    // Listen before seeking: the frame callback can arrive before the 'seeked' event.
    let waiter: (frame: number) => void = () => {};
    const presented = new Promise<number>((resolve) => {
      waiter = resolve;
    });
    this.#waiters.push(waiter);
    const seeked = once(this.#video, 'seeked', SEEKED_TIMEOUT_MS);
    this.#video.currentTime = seconds;
    const frame = (await seeked) ? await within(presented, presentTimeoutMs) : null;
    if (frame === null) this.#waiters = this.#waiters.filter((w) => w !== waiter);
    return frame;
  }
}

/** True once the video's first picture has loaded; false if the video fails to load instead. */
function firstPicture(video: HTMLVideoElement): Promise<boolean> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve(true);
  if (video.error) return Promise.resolve(false);
  return new Promise((resolve) => {
    video.addEventListener('loadeddata', () => resolve(true), { once: true });
    video.addEventListener('error', () => resolve(false), { once: true });
  });
}

/** True when `type` fires on `target` within `ms`, false otherwise. */
function once(target: EventTarget, type: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (fired: boolean) => {
      clearTimeout(timer);
      target.removeEventListener(type, onEvent);
      resolve(fired);
    };
    const onEvent = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    target.addEventListener(type, onEvent);
  });
}

/** The promise's value, or null if it takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
