/**
 * Just enough of a <video> for the frame clock and the player, in Node. A seek is answered a
 * millisecond later with 'seeked' and the frame callback of the picture `shows` picks; the test
 * says when the video loads, fails or presents a frame during playback.
 */
import { vi } from 'vitest';

export class FakeVideo extends EventTarget {
  readyState = 0;
  error: { readonly code: number } | null = null;
  paused = true;
  ended = false;
  playbackRate = 1;
  /** Every `currentTime` set, in seconds. */
  readonly seeks: number[] = [];
  /** The media time of the picture a seek to `seconds` presents; null presents none. */
  shows: (seconds: number) => number | null = (seconds) => seconds;
  #time = 0;
  #callback: VideoFrameRequestCallback | null = null;

  get currentTime(): number {
    return this.#time;
  }

  set currentTime(seconds: number) {
    this.#time = seconds;
    this.seeks.push(seconds);
    setTimeout(() => {
      this.dispatchEvent(new Event('seeked'));
      const shown = this.shows(seconds);
      if (shown !== null) this.present(shown);
    }, 1);
  }

  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
    this.#callback = callback;
    return 1;
  }

  cancelVideoFrameCallback(): void {
    this.#callback = null;
  }

  /** The browser presents the picture at `mediaTime`. */
  present(mediaTime: number): void {
    const callback = this.#callback;
    this.#callback = null;
    callback?.(0, { mediaTime } as VideoFrameCallbackMetadata);
  }

  /** Like Chrome: with no usable source, play() is refused and fires no 'play'. */
  play(): Promise<void> {
    if (this.error?.code === 4) {
      return Promise.reject(new DOMException('no supported source', 'NotSupportedError'));
    }
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }

  /** The first picture has arrived. */
  load(): void {
    this.readyState = 2;
    this.dispatchEvent(new Event('loadeddata'));
  }

  /** A media error: 4, no usable source (a 404 gives this); 2, the network failed. */
  fail(code = 4): void {
    this.error = { code };
    this.dispatchEvent(new Event('error'));
  }
}

export const asVideo = (video: FakeVideo) => video as unknown as HTMLVideoElement;

/** The browser globals the player reads. Undo with vi.unstubAllGlobals(). */
export function stubBrowser(): void {
  vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
}
