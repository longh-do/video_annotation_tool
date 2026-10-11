/**
 * Append-only telemetry: one JSON event per line in telemetry/events.jsonl. The server stamps when
 * each batch arrived and never rewrites the file.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export class TelemetryLog {
  readonly #path: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  /** Appends a batch of events; appends never interleave. */
  append(events: readonly object[]): Promise<void> {
    const receivedAt = Date.now();
    const lines = events.map(
      (event) => `${JSON.stringify({ ...event, received_at_ms: receivedAt })}\n`,
    );
    const write = this.#queue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      await appendFile(this.#path, lines.join(''));
    });
    this.#queue = write.catch(() => {});
    return write;
  }
}
