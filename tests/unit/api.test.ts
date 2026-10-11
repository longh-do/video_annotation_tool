import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { keepIntervals, sidecarBoundaries } from '../../src/core/annotation.ts';
import type {
  ErrorBody,
  GuideResponse,
  QueueResponse,
  RecordingResponse,
  SavedAnnotation,
  SaveResult,
} from '../../src/core/api-types.ts';
import { parseFramesCsv } from '../../src/core/frame-map.ts';
import { emptyTimeline, setStateFrom } from '../../src/core/timeline.ts';
import { AnnotationStore } from '../../src/server/annotations.ts';
import { createApi, type Handler } from '../../src/server/api.ts';
import type { Catalog } from '../../src/server/catalog.ts';
import { ingest } from '../../src/server/ingest.ts';
import { guideVersion } from '../../src/server/task-guides.ts';
import { TelemetryLog } from '../../src/server/telemetry.ts';
import { tempDir, writeRecording } from './fixtures.ts';

/** The task guide for rec-a and rec-b; rec-c has no task. */
const GUIDE =
  '---\nrecordings: rec-a, rec-b\n---\n\n# Stack the cups\n\nKeep from the first touch.\n';
const taskVersion = guideVersion(GUIDE);

let root = '';
let data = '';
let base = '';
let catalog: Catalog;
/** The API under test, with this test's own annotations folder and telemetry file. */
let api: Handler;
let annotations = '';
let telemetry = '';
// As in main.ts: anything the API doesn't turn into a response is a 500.
const server = createServer((req, res) => {
  api(req, res)
    .then((handled) => handled || res.writeHead(404).end())
    .catch(() => res.writeHead(500).end());
});

beforeAll(async () => {
  root = await tempDir();
  data = join(root, 'data');
  await writeRecording(data, { id: 'rec-a' });
  await writeRecording(data, { id: 'rec-b', layout: 'split' });
  await writeRecording(data, { id: 'rec-c' });
  const tasksDir = join(root, 'tasks');
  await mkdir(tasksDir);
  await writeFile(join(tasksDir, 'stack-cups.md'), GUIDE);
  ({ catalog } = await ingest({
    dataDir: data,
    outDir: join(root, 'derived'),
    tasksDir,
    tools: null,
  }));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

// Every test starts with nothing saved and no telemetry, whatever ran before it.
beforeEach(async () => {
  const state = await tempDir();
  annotations = join(state, 'annotations');
  telemetry = join(state, 'events.jsonl');
  api = createApi({
    catalog,
    store: new AnnotationStore(annotations),
    telemetry: new TelemetryLog(telemetry),
    annotatorId: 'tester',
    toolVersion: '0.0.0-test',
  });
});

/** A valid save body for rec-a (or rec-c): keep frames 5–20, the second mark still unchecked. */
async function body(status = 'not_reviewed', id = 'rec-a') {
  const frames = parseFramesCsv(await readFile(join(data, id, 'head-frames.csv'), 'utf8'));
  let t = emptyTimeline(50);
  t = setStateFrom(t, 5, 'keep', 'paused');
  t = setStateFrom(t, 20, 'cut', 'live');
  return {
    annotation: {
      recording_id: id,
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

const put = (revision: string | null, payload: unknown, id = 'rec-a') =>
  fetch(`${base}/api/annotations/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(revision === null ? {} : { 'If-Match': revision }),
    },
    body: JSON.stringify(payload),
  });

const postEvents = (payload: unknown, contentType = 'application/json') =>
  fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: JSON.stringify(payload),
  });

describe('API', () => {
  test('lists the queue in catalog order', async () => {
    const queue = await json<QueueResponse>(fetch(`${base}/api/queue`));
    expect(queue.session).toEqual({ annotatorId: 'tester', toolVersion: '0.0.0-test' });
    expect(queue.recordings.map((r) => r.id)).toEqual(['rec-a', 'rec-b', 'rec-c']);
    expect(queue.recordings[0]).toMatchObject({ status: 'not_reviewed', keepIntervals: 0 });
  });

  test('describes a recording with its task and media URLs, reference camera first', async () => {
    const recording = await json<RecordingResponse>(fetch(`${base}/api/recordings/rec-b`));
    expect(recording.task).toEqual({
      id: 'stack-cups',
      title: 'Stack the cups',
      version: taskVersion,
    });
    expect(recording.cameras[0]).toMatchObject({
      label: 'head',
      video: 'videos/head-0000.mp4',
      videoUrl: '/media/rec-b/videos/head-0000.mp4',
      framesUrl: '/media/rec-b/head-frames.csv',
      frameCount: 50,
    });
    const untasked = await json<RecordingResponse>(fetch(`${base}/api/recordings/rec-c`));
    expect(untasked.task).toBeNull();
    expect((await fetch(`${base}/api/recordings/nope`)).status).toBe(404);
  });

  test('serves a task guide as Markdown without its header, with its title and version', async () => {
    const res = await fetch(`${base}/api/tasks/stack-cups`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await json<GuideResponse>(res)).toEqual({
      info: { id: 'stack-cups', title: 'Stack the cups', version: taskVersion },
      markdown: '# Stack the cups\n\nKeep from the first touch.\n',
    });
    expect((await fetch(`${base}/api/tasks/nope`)).status).toBe(404);
    // Only the catalog's own tasks, not what every object has.
    expect((await fetch(`${base}/api/tasks/constructor`)).status).toBe(404);
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
    await writeFile(join(data, 'rec-b', 'secret.txt'), 'secret');
    const outside = await fetch(`${base}/media/rec-b/videos%2F..%2F..%2Fsecret.txt`);
    expect(outside.status).toBe(404);
    expect(await outside.text()).not.toBe('secret');
  });

  test('lets the browser keep a frames CSV, checking each time that it is current', async () => {
    const url = `${base}/media/rec-b/head-frames.csv`;
    const first = await fetch(url);
    expect(first.headers.get('cache-control')).toBe('no-cache');
    const etag = first.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    await first.text();
    const again = await fetch(url, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    const changed = await fetch(url, { headers: { 'If-None-Match': 'W/"1-2"' } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).toBe(etag);
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
      guideline_version: taskVersion,
      tool_version: '0.0.0-test',
    });

    const queue = await json<QueueResponse>(fetch(`${base}/api/queue`));
    expect(queue.recordings[0]).toMatchObject({ status: 'complete', keepIntervals: 1 });
  });

  test('a bad annotation file is named, and every other recording still opens', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await put('"0"', await body('complete', 'rec-c'), 'rec-c')).status).toBe(200);
      // Files written by hand: one is not JSON, the other belongs to another recording.
      await writeFile(join(annotations, 'rec-a.json'), '{ "recording_id": "rec-a",');
      const other = (await body('complete', 'rec-c')).annotation;
      await writeFile(join(annotations, 'rec-b.json'), JSON.stringify(other));

      // Listed as needing review, so the app never opens them by itself.
      const queue = await fetch(`${base}/api/queue`);
      expect(queue.status).toBe(200);
      const statuses = (await json<QueueResponse>(queue)).recordings.map((r) => r.status);
      expect(statuses).toEqual(['needs_review', 'needs_review', 'complete']);
      expect(warn.mock.calls.map(([line]) => String(line)).sort()).toEqual([
        expect.stringMatching(
          /^! the saved annotation of rec-a is not valid JSON: .+; listed as needing review$/,
        ),
        '! the saved annotation of rec-b breaks the contract: recording_id must be "rec-b"; ' +
          'listed as needing review',
      ]);

      const broken = await fetch(`${base}/api/annotations/rec-b`);
      expect(broken.status).toBe(500);
      expect(await json<ErrorBody>(broken)).toMatchObject({
        problems: ['recording_id must be "rec-b"'],
      });
      expect((await fetch(`${base}/api/annotations/rec-a`)).status).toBe(500);
      expect((await fetch(`${base}/api/annotations/rec-c`)).status).toBe(200);
    } finally {
      warn.mockRestore();
    }
  });

  test('an edited guide shows at once, and saves are stamped with its new version', async () => {
    const path = join(root, 'tasks', 'stack-cups.md');
    const before = await readFile(path, 'utf8');
    try {
      await writeFile(path, before.replace('# Stack the cups', '# Stack the red cups'));
      const recording = await json<RecordingResponse>(fetch(`${base}/api/recordings/rec-a`));
      expect(recording.task?.title).toBe('Stack the red cups');
      expect(recording.task?.version).not.toBe(taskVersion);
      const guide = await json<GuideResponse>(fetch(`${base}/api/tasks/stack-cups`));
      expect(guide.markdown).toContain('red cups');
      const { revision } = await json<SavedAnnotation>(fetch(`${base}/api/annotations/rec-a`));
      expect((await put(`"${revision}"`, await body())).status).toBe(200);
      const record = await json<SavedAnnotation>(fetch(`${base}/api/annotations/rec-a`));
      expect(record.sidecar?.guideline_version).toBe(recording.task?.version);
    } finally {
      await writeFile(path, before);
    }
  });

  test('a guide whose heading was deleted is titled by its file name, not the old heading', async () => {
    const path = join(root, 'tasks', 'stack-cups.md');
    const before = await readFile(path, 'utf8');
    try {
      await writeFile(path, '---\nrecordings: rec-a, rec-b\n---\n\nKeep.\n');
      const guide = await json<GuideResponse>(fetch(`${base}/api/tasks/stack-cups`));
      expect(guide.info.title).toBe('stack-cups.md');
    } finally {
      await writeFile(path, before);
    }
  });

  test('stamps a recording without a task with no guideline version', async () => {
    expect((await put('"0"', await body('not_reviewed', 'rec-c'), 'rec-c')).status).toBe(200);
    const record = await json<SavedAnnotation>(fetch(`${base}/api/annotations/rec-c`));
    expect(record.sidecar).toMatchObject({ annotator_id: 'tester', guideline_version: null });
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
    const csv = join(data, 'rec-b', 'annotation-data', 'head-frames.csv');
    await rename(csv, `${csv}.away`);
    const failed = await put('"0"', {}, 'rec-b').catch(() => null);
    expect(failed?.status).not.toBe(200);
    await rename(`${csv}.away`, csv);
    const retry = await put('"0"', {}, 'rec-b');
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
    const res = await postEvents([{ event: 'task_opened', recording_id: 'rec-a' }]);
    expect(res.status).toBe(204);
    const lines = (await readFile(telemetry, 'utf8')).trim().split('\n');
    const last = JSON.parse(lines.at(-1)!);
    expect(last).toMatchObject({ event: 'task_opened', recording_id: 'rec-a' });
    expect(Math.abs(last.received_at_ms - Date.now())).toBeLessThan(60_000);
    const tooMany = Array.from({ length: 1001 }, () => ({ event: 'x' }));
    expect((await postEvents(tooMany)).status).toBe(400);
    expect((await postEvents({ event: 'x' })).status).toBe(400);
  });

  test('refuses a body not sent as JSON: other sites can send text/plain unasked', async () => {
    const forged = await postEvents([{ event: 'task_opened' }], 'text/plain;charset=UTF-8');
    expect(forged.status).toBe(415);
    const save = await fetch(`${base}/api/annotations/rec-a`, {
      method: 'PUT',
      headers: { 'If-Match': '"0"' },
      body: JSON.stringify(await body()),
    });
    expect(save.status).toBe(415);
    expect(await readFile(telemetry, 'utf8').catch(() => 'none')).toBe('none');
    expect((await postEvents([], 'application/json; charset=utf-8')).status).toBe(204);
  });

  test('answers unknown routes and wrong methods', async () => {
    expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
    expect((await fetch(`${base}/api/queue`, { method: 'POST' })).status).toBe(405);
  });
});
