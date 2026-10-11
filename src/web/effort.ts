/**
 * Effort per recording: wall time with it open, and active time — the page visible and the
 * annotator either playing the video or using the keyboard or mouse within the last IDLE_MS.
 * A break with the tab left open counts as wall time only. Active time ÷ video length is the
 * real-time factor the operation is measured by.
 */
const IDLE_MS = 30_000;

export interface Effort {
  readonly activeMs: number;
  readonly wallMs: number;
}

export class EffortClock {
  readonly #isPlaying: () => boolean;
  #activeMs: number;
  #wallMs: number;
  #lastTick = performance.now();
  #lastInput = performance.now();

  constructor(start: Effort, isPlaying: () => boolean) {
    this.#activeMs = start.activeMs;
    this.#wallMs = start.wallMs;
    this.#isPlaying = isPlaying;
  }

  /** Call on every key press and pointer event. */
  noteInput(): void {
    this.#lastInput = performance.now();
  }

  /** Adds the time since the last reading and returns the totals. */
  read(): Effort {
    const now = performance.now();
    const elapsed = now - this.#lastTick;
    this.#lastTick = now;
    if (document.visibilityState === 'visible') {
      this.#wallMs += elapsed;
      if (this.#isPlaying() || now - this.#lastInput < IDLE_MS) this.#activeMs += elapsed;
    }
    return { activeMs: this.#activeMs, wallMs: this.#wallMs };
  }
}
