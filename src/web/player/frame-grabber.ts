/**
 * Still frames for the check filmstrip. A second, detached <video> seeks frame by frame (each
 * seek verified by its own FrameClock) and the picture is copied into a small bitmap. The main
 * video never moves, so the annotator keeps their place.
 */
import type { FrameMap } from '../../core/frame-map.ts';
import { FrameClock } from './frame-clock.ts';

const WIDTH = 192;
/** Enough for several boundaries' strips; the least recently used bitmaps are released. */
const CACHE_SIZE = 240;

export class FrameGrabber {
  readonly #video: HTMLVideoElement;
  readonly #clock: FrameClock;
  readonly #cache = new Map<number, ImageBitmap>();
  #work: Promise<unknown> = Promise.resolve();

  constructor(src: string, frames: FrameMap) {
    this.#video = document.createElement('video');
    this.#video.muted = true;
    this.#video.preload = 'auto';
    this.#video.src = src;
    this.#clock = new FrameClock(this.#video, frames);
  }

  /**
   * Frame `k` as a bitmap; null if its seek could not be verified, or if `signal` was aborted
   * before its turn came (the strip it was for is gone). One grab at a time.
   */
  grab(k: number, signal?: AbortSignal): Promise<ImageBitmap | null> {
    const cached = this.#cache.get(k);
    if (cached) {
      // Most recently used goes last, so the strip on screen is never evicted.
      this.#cache.delete(k);
      this.#cache.set(k, cached);
      return Promise.resolve(cached);
    }
    const result = this.#work.then(() => (signal?.aborted ? null : this.#grabNow(k)));
    this.#work = result.catch(() => {});
    return result;
  }

  dispose(): void {
    this.#clock.dispose();
    for (const bitmap of this.#cache.values()) bitmap.close();
    this.#cache.clear();
    this.#video.removeAttribute('src');
    this.#video.load();
  }

  async #grabNow(k: number): Promise<ImageBitmap | null> {
    const cached = this.#cache.get(k);
    if (cached) return cached;
    if (this.#video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise((resolve) =>
        this.#video.addEventListener('loadeddata', resolve, { once: true }),
      );
    }
    if ((await this.#clock.seekToFrame(k)) !== true) return null;
    const height = Math.round((WIDTH * this.#video.videoHeight) / this.#video.videoWidth);
    const bitmap = await createImageBitmap(this.#video, {
      resizeWidth: WIDTH,
      resizeHeight: height,
    });
    this.#cache.set(k, bitmap);
    if (this.#cache.size > CACHE_SIZE) {
      const [oldest, evicted] = this.#cache.entries().next().value ?? [];
      if (oldest !== undefined && evicted) {
        evicted.close();
        this.#cache.delete(oldest);
      }
    }
    return bitmap;
  }
}
