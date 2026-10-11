/**
 * Effort per recording: wall time with it on screen, and active time — the page visible and the
 * annotator either playing the video or having used the keyboard or mouse within the last
 * IDLE_MS. A break with the tab left open counts as wall time only. Active time ÷ video length is
 * the real-time factor the operation is measured by.
 *
 * Each stretch of time is credited with the state it was spent in: every change (visibility,
 * playback, input) first closes the stretch before it.
 */
const IDLE_MS = 30_000;

export interface Effort {
  readonly activeMs: number;
  readonly wallMs: number;
}

export class EffortClock {
  #activeMs: number;
  #wallMs: number;
  #playing = false;
  #visible: boolean;
  #since = performance.now();
  /** Opening the recording counts as input. */
  #lastInput = this.#since;

  constructor(start: Effort, visible: boolean) {
    this.#activeMs = start.activeMs;
    this.#wallMs = start.wallMs;
    this.#visible = visible;
  }

  /** A key press or a pointer action. */
  noteInput(): void {
    this.#advance();
    this.#lastInput = this.#since;
  }

  setPlaying(playing: boolean): void {
    this.#advance();
    this.#playing = playing;
  }

  setVisible(visible: boolean): void {
    this.#advance();
    this.#visible = visible;
  }

  read(): Effort {
    this.#advance();
    return { activeMs: this.#activeMs, wallMs: this.#wallMs };
  }

  #advance(): void {
    const now = performance.now();
    const from = this.#since;
    this.#since = now;
    if (!this.#visible) return;
    this.#wallMs += now - from;
    const activeUntil = this.#playing ? now : Math.min(now, this.#lastInput + IDLE_MS);
    this.#activeMs += Math.max(activeUntil - from, 0);
  }
}
