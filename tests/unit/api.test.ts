import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { keepIntervals, sidecarBoundaries } from '../../src/core/annotation.ts';
import type {
  ErrorBody,
  QueueResponse,
  RecordingResponse,
  SavedAnnotation,
  SaveResult,
} from '../../src/core/api-types.ts';
import { parseFramesCsv } from '../../src/core/frame-map.ts';
import { emptyTimeline, setStateFrom } from '../../src/core/timeline.ts';
import { AnnotationStore } from '../../src/server/annotations.ts';
import { createApi } from '../../src/server/api.ts';
import { ingest } from '../../src/server/ingest.ts';
import { TelemetryLog } from '../../src/server/telemetry.ts';
import { tempDir, writeRecording } from './fixtures.ts';

let root = '';
let base = '';
const server = createServer();

beforeAll(async () => {
  root = await tempDir();
  await writeRecording(root, { id: 'rec-a' });
  await writeRecording(root, { id: 'rec-b', layout: 'split' });
  const { catalog } = await ingest({
    dataDir: root,
    outDir: join(root, 'derived'),
    guidelinePath: null,
    tools: null,
  });
  const api = createApi({
    catalog,
    store: new AnnotationStore(join(root, 'annotations')),
    telemetry: new TelemetryLog(join(root, 'telemetry', 'events.jsonl')),
    annotatorId: 'tester',
    toolVersion: '0.0.0-test',
  });
  // As in main.ts: anything the API doesn't turn into a response is a 500.
  server.on('request', (req, res) => {
    api(req, res)
      .then((handled) => handled || res.writeHead(404).end())
      .catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

/** A valid save body for rec-a: keep frames 5–20, the second mark still unchecked. */
async function body(status = 'not_reviewed') {
  const frames = parseFramesCsv(await readFile(join(root, 'rec-a', 'head-frames.csv'), 'utf8'));
  let t = emptyTimeline(50);
  t = setStateFrom(t, 5, 'keep', 'paused');
  t = setStateFrom(t, 20, 'cut', 'live');
  return {
    annotation: {
      recording_id: 'rec-a',
      reference_video: 'videos/head-0000.mp4',
      status,
      keep_intervals: keepIntervals(t, frames),
      notes: '',
    },
    sidecar: {
      schema_version: 1,
      frame_count: 50,
      boundaries: sidecarBoundaries(t, frames),
      review_reason: null,
      resume: { frame: 20, playback_rate: 2 },
      effort: { active_ms: 1200, wall_ms: 1500, edits: 2, undos: 0 },
    },
  };
}

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

const put = (revision: string | null, payload: unknown) =>
  fetch(`${base}/api/annotations/rec-a`, {
    method: 'PUT',
    headers: revision === null ? {} : { 'If-Match': revision },
    body: JSON.stringify(payload),
  });

describe('API', () => {
  test('lists the queue in catalog order', async () => {
    const queue = await json<QueueResponse>(fetch(`${base}/api/queue`));
    expect(queue.session).toMatchObject({ annotatorId: 'tester', toolVersion: '0.0.0-test' });
    expect(queue.recordings.map((r) => r.id)).toEqual(['rec-a', 'rec-b']);
    expect(queue.recordings[0]).toMatchObject({ status: 'not_reviewed', keepIntervals: 0 });
  });

  test('describes a recording with media URLs, reference camera first', async () => {
    const recording = await json<RecordingResponse>(fetch(`${base}/api/recordings/rec-b`));
    expect(recording.cameras[0]).toMatchObject({
      label: 'head',
      video: 'videos/head-0000.mp4',
      videoUrl: '/media/rec-b/videos/head-0000.mp4',
      framesUrl: '/media/rec-b/head-frames.csv',
      frameCount: 50,
    });
    expect((await fetch(`${base}/api/recordings/nope`)).status).toBe(404);
  });

  test('serves media through the catalog only, with byte ranges', async () => {
    const video = await fetch(`${base}/media/rec-b/videos/head-0000.mp4`, {
      headers: { Range: 'bytes=0-3' },
    });
    expect(video.status).toBe(206);
    expect(await video.text()).toBe('not ');
    const csv = await fetch(`${base}/media/rec-b/head-frames.csv`);
    expect((await csv.text()).split('\n')[0]).toBe(
      'video_file,frame_index,video_time_s,source_ts_ns,source_frame_id',
    );
    expect((await fetch(`${base}/media/rec-b/manifest.json`)).status).toBe(404);
    // A real file next to the recording, reached by an encoded "../": never served.
    await writeFile(join(root, 'rec-b', 'secret.txt'), 'secret');
    const outside = await fetch(`${base}/media/rec-b/videos%2F..%2F..%2Fsecret.txt`);
    expect(outside.status).toBe(404);
    expect(await outside.text()).not.toBe('secret');
  });

  test('saves with optimistic concurrency: a stale revision gets 412', async () => {
    expect((await fetch(`${base}/api/annotations/rec-a`)).status).toBe(404);
    const first = await put('"0"', await body());
    expect(first.status).toBe(200);
    expect(await json<SaveResult>(first)).toMatchObject({ revision: 1 });

    const stale = await put('"0"', await body());
    expect(stale.status).toBe(412);
    expect(await json<ErrorBody>(stale)).toMatchObject({ revision: 1 });

    expect((await put('"1"', await body('complete'))).status).toBe(200);
    const saved = await fetch(`${base}/api/annotations/rec-a`);
    expect(saved.headers.get('etag')).toBe('"2"');
    const record = await json<SavedAnnotation>(saved);
    expect(record.annotation.status).toBe('complete');
    // Who saved it, and against which guideline, is the server's word, not the client's.
    expect(record.sidecar).toMatchObject({
      revision: 2,
      annotator_id: 'tester',
      tool_version: '0.0.0-test',
    });

    const queue = await json<QueueResponse>(fetch(`${base}/api/queue`));
    expect(queue.recordings[0]).toMatchObject({ status: 'complete', keepIntervals: 1 });
  });

  test('refuses a save without If-Match, or one that breaks the contract', async () => {
    expect((await put(null, await body())).status).toBe(428);
    const valid = await body();
    const broken = {
      ...valid,
      annotation: { ...valid.annotation, keep_intervals: [{ start_ns: '1', end_ns: '0' }] },
    };
    const res = await put('"2"', broken);
    expect(res.status).toBe(400);
    expect((await json<ErrorBody>(res)).problems?.join('\n')).toMatch(
      /start_ns must be before end_ns/,
    );
  });

  test('refuses a sidecar with fields the server stamps itself', async () => {
    const valid = await body();
    const res = await put('"2"', {
      ...valid,
      sidecar: { ...valid.sidecar, annotator_id: 'mallory' },
    });
    expect((await json<ErrorBody>(res)).problems).toEqual([
      'sidecar: unexpected fields: annotator_id',
    ]);
  });

  test('answers a malformed If-Match, a malformed URL and an oversized body with 4xx', async () => {
    expect((await put('3', await body())).status).toBe(428);
    expect((await fetch(`${base}/api/annotations/%E0%A4%A`)).status).toBe(400);
    const huge = await put('"2"', { padding: 'x'.repeat(2_100_000) });
    expect(huge.status).toBe(413);
    const status = await new Promise<number | undefined>((resolve) => {
      request(`${base}//`, (res) => resolve(res.statusCode)).end();
    });
    expect(status).toBe(400);
  });

  test('recovers when a frames CSV was briefly unreadable', async () => {
    const csv = join(root, 'rec-b', 'annotation-data', 'head-frames.csv');
    await rename(csv, `${csv}.away`);
    const failed = await fetch(`${base}/api/annotations/rec-b`, {
      method: 'PUT',
      headers: { 'If-Match': '"0"' },
      body: '{}',
    }).catch(() => null);
    expect(failed?.status).not.toBe(200);
    await rename(`${csv}.away`, csv);
    const retry = await fetch(`${base}/api/annotations/rec-b`, {
      method: 'PUT',
      headers: { 'If-Match': '"0"' },
      body: '{}',
    });
    expect(retry.status).toBe(400); // read the CSV this time, then refused the empty body
  });

  test('refuses a contract file that disagrees with its sidecar', async () => {
    const valid = await body();
    const res = await put('"2"', {
      ...valid,
      annotation: { ...valid.annotation, keep_intervals: [] },
    });
    expect((await json<ErrorBody>(res)).problems).toEqual([
      "keep_intervals don't match the sidecar's boundaries",
    ]);
  });

  test('appends telemetry events', async () => {
    const res = await fetch(`${base}/api/events`, {
      method: 'POST',
      body: JSON.stringify([{ event: 'task_opened', recording_id: 'rec-a' }]),
    });
    expect(res.status).toBe(204);
    const lines = (await readFile(join(root, 'telemetry', 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    const last = JSON.parse(lines.at(-1)!);
    expect(last).toMatchObject({ event: 'task_opened', recording_id: 'rec-a' });
    expect(Math.abs(last.received_at_ms - Date.now())).toBeLessThan(60_000);
    const tooMany = Array.from({ length: 1001 }, () => ({ event: 'x' }));
    const flood = await fetch(`${base}/api/events`, {
      method: 'POST',
      body: JSON.stringify(tooMany),
    });
    expect(flood.status).toBe(400);
    const bad = await fetch(`${base}/api/events`, {
      method: 'POST',
      body: JSON.stringify({ event: 'x' }),
    });
    expect(bad.status).toBe(400);
  });

  test('answers unknown routes and wrong methods', async () => {
    expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
    expect((await fetch(`${base}/api/queue`, { method: 'POST' })).status).toBe(405);
  });
});
