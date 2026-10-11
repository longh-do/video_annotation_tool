import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  RecordingResponse,
  SavedAnnotation,
  SavePayload,
} from '../../../src/core/api-types.ts';
import { Sessions } from '../../../src/web/sessions.ts';
import { framesCsv } from '../synthetic.ts';

const csv = framesCsv([
  { file: 'head-0000.mp4', startNs: 3_000_000_000_000n, gapsUs: new Array(99).fill(33_000) },
]);

/** A fake server: any recording's media, and annotations saved with revisions. */
function server() {
  const saved = new Map<string, SavedAnnotation>();
  const annotationReads = new Map<string, number>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const recording = url.split('/')[url.startsWith('/media/') ? 2 : 3]!;
      if (url.startsWith('/api/recordings/')) {
        const info: RecordingResponse = {
          id: recording,
          durationS: 3.3,
          cameras: [
            {
              name: 'umi.head.camera.enc',
              label: 'head',
              video: 'videos/head-0000.mp4',
              videoUrl: `/media/${recording}/videos/head-0000.mp4`,
              framesUrl: `/media/${recording}/head-frames.csv`,
              frameCount: 100,
              width: 640,
              height: 480,
            },
          ],
          thumbnails: null,
          task: null,
        };
        return Response.json(info);
      }
      if (url.endsWith('.csv')) return new Response(csv);
      if (url.endsWith('.mp4')) return new Response('vi', { status: 206 });
      if (url.startsWith('/api/annotations/')) {
        if (init.method === 'PUT') {
          const payload = JSON.parse(String(init.body)) as SavePayload;
          const revision = (saved.get(recording)?.revision ?? 0) + 1;
          const sidecar = { ...payload.sidecar, revision, saved_at: '', annotator_id: 'a1' };
          const record = { guideline_version: null, tool_version: '0.1.0', ...sidecar };
          saved.set(recording, { revision, annotation: payload.annotation, sidecar: record });
          return Response.json({ revision });
        }
        annotationReads.set(recording, (annotationReads.get(recording) ?? 0) + 1);
        const found = saved.get(recording);
        return found ? Response.json(found) : Response.json({ revision: 0 }, { status: 404 });
      }
      throw new Error(`unexpected request ${url}`);
    }),
  );
  /** Another tab saves on top of whatever is there. */
  const saveElsewhere = (recording: string) => {
    const current = saved.get(recording)!;
    saved.set(recording, { ...current, revision: current.revision + 1 });
  };
  return { annotationReads, saveElsewhere };
}

describe('sessions', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('opening a recording twice at once loads it once', async () => {
    const { annotationReads } = server();
    const sessions = new Sessions(null, null);
    const [a, b] = await Promise.all([sessions.open('rec-1'), sessions.open('rec-1')]);
    expect(a).toBe(b);
    expect(annotationReads.get('rec-1')).toBe(1);
  });

  test('coming back to a recording keeps its annotation, undo history and all', async () => {
    server();
    const sessions = new Sessions(null, null);
    const first = await sessions.open('rec-2');
    first.annotation.editor.dispatch({ type: 'mark', frame: 10, state: 'keep', origin: 'paused' });
    const again = await sessions.open('rec-2'); // saves what is pending first
    expect(again.fresh).toBe(false);
    expect(again.annotation).toBe(first.annotation);
    expect(again.annotation.editor.getState().history.past).toHaveLength(1);
  });

  test('if another tab saved the recording since, its version is opened instead', async () => {
    const { saveElsewhere } = server();
    const sessions = new Sessions(null, null);
    const first = await sessions.open('rec-3');
    first.annotation.editor.dispatch({ type: 'mark', frame: 10, state: 'keep', origin: 'paused' });
    await first.annotation.saver.flush();
    saveElsewhere('rec-3');
    const again = await sessions.open('rec-3');
    expect(again.fresh).toBe(true);
    expect(again.annotation).not.toBe(first.annotation);
    expect(again.annotation.saver.revision).toBe(2);
  });
});
