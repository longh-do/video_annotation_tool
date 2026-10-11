import type { FrameClock, SeekResult } from './frame-clock.ts';

/**
 * One seek in flight per video, and the newest request wins. Requests are relative to `target`,
 * the frame the video is heading to, so five quick presses of → move exactly five frames.
 */
export class SeekQueue {
  readonly #clock: FrameClock;
  readonly #onSettled: (frame: number, result: SeekResult) => void;
  #wanted: number | null = null;
  #inFlight: number | null = null;

  constructor(clock: FrameClock, onSettled: (frame: number, result: SeekResult) => void) {
    this.#clock = clock;
    this.#onSettled = onSettled;
  }

  /** The frame the video shows once pending seeks are done. */
  get target(): number {
    return this.#wanted ?? this.#inFlight ?? this.#clock.displayed;
  }

  request(frame: number): void {
    this.#wanted = frame;
    if (this.#inFlight === null) void this.#run();
  }

  async #run(): Promise<void> {
    while (this.#wanted !== null) {
      const frame = this.#wanted;
      this.#inFlight = frame;
      this.#wanted = null;
      const result = await this.#clock.seekToFrame(frame);
      if (this.#wanted === null) this.#onSettled(frame, result);
    }
    this.#inFlight = null;
  }
}
