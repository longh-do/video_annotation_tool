/**
 * Telemetry: what the annotator did and when, appended to telemetry/events.jsonl on the server.
 * Events are batched and sent every few seconds, and with sendBeacon when the page is hidden or
 * closed, so the last ones aren't lost. Every event carries the same envelope, so a session can be
 * replayed and measured: speed, effort, and time spent per checked boundary.
 */
export interface TelemetryContext {
  readonly annotatorId: string;
  readonly toolVersion: string;
  readonly guidelineVersion: string | null;
}

/** Which recording an event is about, and where its video was. */
export interface EventPlace {
  readonly recordingId: string;
  /** The source timestamp of the frame on screen, as a decimal string. */
  readonly mediaPosNs: string | null;
  readonly playbackRate: number;
}

const FLUSH_MS = 5000;

export class Telemetry {
  readonly #context: TelemetryContext;
  #buffer: object[] = [];
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #onHide = () => {
    if (document.visibilityState === 'hidden') this.#send(true);
  };

  constructor(context: TelemetryContext) {
    this.#context = context;
    this.#timer = setInterval(() => this.#send(false), FLUSH_MS);
    document.addEventListener('visibilitychange', this.#onHide);
    window.addEventListener('pagehide', this.#onHide);
  }

  log(place: EventPlace, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.#buffer.push({
      event_id: crypto.randomUUID(),
      event,
      ts_wall_ms: Date.now(),
      ts_mono_ms: Math.round(performance.now()),
      annotator_id: this.#context.annotatorId,
      recording_id: place.recordingId,
      tool_version: this.#context.toolVersion,
      guideline_version: this.#context.guidelineVersion,
      media_pos_ns: place.mediaPosNs,
      playback_rate: place.playbackRate,
      page_visible: document.visibilityState === 'visible',
      ...fields,
    });
  }

  /** Sends what is left and stops. */
  dispose(): void {
    clearInterval(this.#timer);
    document.removeEventListener('visibilitychange', this.#onHide);
    window.removeEventListener('pagehide', this.#onHide);
    this.#send(true);
  }

  #send(leaving: boolean): void {
    if (this.#buffer.length === 0) return;
    const body = JSON.stringify(this.#buffer.splice(0));
    // sendBeacon survives the page closing; otherwise a keepalive fetch.
    if (
      leaving &&
      navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }))
    ) {
      return;
    }
    void fetch('/api/events', { method: 'POST', body, keepalive: true }).catch(() => {});
  }
}
