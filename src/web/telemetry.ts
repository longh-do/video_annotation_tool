/**
 * Telemetry: what the annotator did and when, appended to telemetry/events.jsonl on the server.
 * Events are batched and sent every few seconds; a batch that doesn't get through is kept for the
 * next try. When the page is hidden or closed, a beacon (which outlives the page) takes what it
 * can, and the rest waits in local storage for the next page. Every event carries the same
 * envelope, so a session can be replayed and measured: speed, effort, and time spent per checked
 * boundary.
 */
export interface TelemetryContext {
  readonly annotatorId: string;
  readonly toolVersion: string;
}

/** Which recording an event is about, and where its video was. */
export interface EventPlace {
  readonly recordingId: string;
  /** The version of the recording's task guide, if it has one. */
  readonly guidelineVersion: string | null;
  /** The source timestamp of the frame on screen, as a decimal string. */
  readonly mediaPosNs: string | null;
  readonly playbackRate: number;
}

const FLUSH_MS = 5000;
/** The server takes at most this many events per request. */
const MAX_BATCH = 1000;
/** About 37 KB. All beacons in flight share 64 KB, so a page sends one when it goes away. */
const BEACON_BATCH = 100;
/** Kept while the server can't be reached; the oldest go first. */
const MAX_KEPT = 5000;
/** Where events that a closing page couldn't send wait for the next page. */
const OUTBOX = 'telemetry-outbox';

export class Telemetry {
  readonly #context: TelemetryContext;
  #buffer: object[] = takeOutbox();
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #onVisibility = () => {
    if (document.visibilityState === 'hidden') this.#send(true);
  };
  readonly #onPageHide = () => this.#send(true);

  constructor(context: TelemetryContext) {
    this.#context = context;
    this.#timer = setInterval(() => this.#send(false), FLUSH_MS);
    document.addEventListener('visibilitychange', this.#onVisibility);
    window.addEventListener('pagehide', this.#onPageHide);
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
      guideline_version: place.guidelineVersion,
      media_pos_ns: place.mediaPosNs,
      playback_rate: place.playbackRate,
      page_visible: document.visibilityState === 'visible',
      ...fields,
    });
  }

  /** Sends what is left and stops. */
  dispose(): void {
    clearInterval(this.#timer);
    document.removeEventListener('visibilitychange', this.#onVisibility);
    window.removeEventListener('pagehide', this.#onPageHide);
    this.#send(true);
  }

  #send(leaving: boolean): void {
    if (leaving) {
      const batch = this.#buffer.splice(0, BEACON_BATCH);
      const blob = new Blob([JSON.stringify(batch)], { type: 'application/json' });
      if (batch.length > 0 && !navigator.sendBeacon('/api/events', blob)) this.#keep(batch);
      // The rest stays here if the page does, and waits for the next page if it doesn't.
      storeOutbox(this.#buffer);
      return;
    }
    if (this.#buffer.length === 0) return;
    const batch = this.#buffer.splice(0, MAX_BATCH);
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    }).then(
      (response) => {
        if (response.status >= 500) this.#keep(batch);
        else storeOutbox([]); // the page stayed: what was set aside is on its way from here
      },
      () => this.#keep(batch),
    );
  }

  /** Puts a batch that didn't get through back in front of what came since. */
  #keep(batch: readonly object[]): void {
    this.#buffer = [...batch, ...this.#buffer].slice(-MAX_KEPT);
  }
}

/** Events a previous page set aside; they are sent first. */
function takeOutbox(): object[] {
  try {
    const saved = localStorage.getItem(OUTBOX);
    localStorage.removeItem(OUTBOX);
    return saved ? (JSON.parse(saved) as object[]) : [];
  } catch {
    return [];
  }
}

function storeOutbox(events: readonly object[]): void {
  try {
    if (events.length === 0) localStorage.removeItem(OUTBOX);
    else localStorage.setItem(OUTBOX, JSON.stringify(events));
  } catch {
    // No local storage (private window, blocked site data): they go with the page.
  }
}
