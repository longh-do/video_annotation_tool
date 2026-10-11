import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  RecordingResponse,
  SavedAnnotation,
  SavePayload,
} from '../../../src/core/api-types.ts';
import { Journal } from '../../../src/web/journal.ts';
import { type Opened, Sessions } from '../../../src/web/sessions.ts';
import { framesCsv } from '../synthetic.ts';

const csv = framesCsv([
  { file: 'head-0000.mp4', startNs: 3_000_000_000_000n, gapsUs: new Array(99).fill(33_000) },
]);

/** A fake server: any recording's media, and annotations saved with revisions (If-Match). */
function server() {
  const saved = new Map<string, SavedAnnotation>();
  /** Saves per recording; it outlives deleted annotation files, as the server's history does. */
  const revisions = new Map<string, number>();
  const annotationReads = new Map<string, number>();
  const ifMatch: string[] = [];
  /** Replies to saves wait for this (the saves themselves are done). */
  let late: Promise<void> | null = null;
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
        const current = revisions.get(recording) ?? 0;
        if (init.method === 'PUT') {
          const match = (init.headers as Record<string, string>)['If-Match']!;
          ifMatch.push(match);
          if (match !== `"${current}"`) {
            return Response.json({ error: 'stale', revision: current }, { status: 412 });
          }
          const payload = JSON.parse(String(init.body)) as SavePayload;
          const revision = current + 1;
          const sidecar = { ...payload.sidecar, revision, saved_at: '', annotator_id: 'a1' };
          const record = { guideline_version: null, tool_version: '0.1.0', ...sidecar };
          saved.set(recording, { revision, annotation: payload.annotation, sidecar: record });
          revisions.set(recording, revision);
          await late;
          return Response.json({ revision });
        }
        annotationReads.set(recording, (annotationReads.get(recording) ?? 0) + 1);
        const found = saved.get(recording);
        return found ? Response.json(found) : Response.json({ revision: current }, { status: 404 });
      }
      throw new Error(`unexpected request ${url}`);
    }),
  );
  return {
    annotationReads,
    /** The If-Match of every save, in order. */
    ifMatch,
    frames: (recording: string) => saved.get(recording)?.sidecar?.boundaries.map((b) => b.frame),
    /** Another tab saves on top of whatever is there. */
    saveElsewhere(recording: string) {
      const current = saved.get(recording)!;
      saved.set(recording, { ...current, revision: current.revision + 1 });
      revisions.set(recording, current.revision + 1);
    },
    /** Someone deletes the annotation files; the server's history keeps counting. */
    deleteFiles(recording: string) {
      saved.delete(recording);
    },
    /** Replies to saves come late, until the returned function is called. */
    lateReplies(): () => void {
      let release = () => {};
      late = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        late = null;
        release();
      };
    },
  };
}

/** Web Locks as the tabs of one browser share them. */
function browserLocks() {
  const held = new Set<string>();
  return {
    request(name: string, _options: object, callback: (lock: object | null) => unknown) {
      if (held.has(name)) return Promise.resolve(callback(null));
      held.add(name);
      return Promise.resolve(callback({ name })).finally(() => held.delete(name));
    },
  };
}

const mark = (frame: number) => ({ type: 'mark', frame, state: 'keep', origin: 'paused' }) as const;
const framesOf = ({ annotation }: Opened) =>
  annotation.editor.getState().history.present.boundaries.map((b) => b.frame);

describe('sessions', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // One browser: its IndexedDB and its locks are shared by every tab.
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('navigator', { locks: browserLocks() });
  });
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
    first.annotation.editor.dispatch(mark(10));
    const again = await sessions.open('rec-2'); // saves what is pending first
    expect(again.fresh).toBe(false);
    expect(again.annotation).toBe(first.annotation);
    expect(again.annotation.editor.getState().history.past).toHaveLength(1);
  });

  test('if another tab saved the recording since, its version is opened instead', async () => {
    const { saveElsewhere } = server();
    const sessions = new Sessions(null, null);
    const first = await sessions.open('rec-3');
    first.annotation.editor.dispatch(mark(10));
    await first.annotation.saver.flush();
    saveElsewhere('rec-3');
    const again = await sessions.open('rec-3');
    expect(again.fresh).toBe(true);
    expect(again.annotation).not.toBe(first.annotation);
    expect(again.annotation.saver.revision).toBe(2);
  });

  test("a second tab on the same recording can't edit it, so it can't recover stale edits over the first's", async () => {
    const remote = server();
    const journal = await Journal.open();
    const tabA = new Sessions(journal, null);
    const tabB = new Sessions(journal, null);
    const a = await tabA.open('rec');
    const b = await tabB.open('rec');
    expect(b.annotation.openElsewhere).toBe(true);

    const release = remote.lateReplies();
    a.annotation.editor.dispatch(mark(10));
    await vi.advanceTimersByTimeAsync(300); // A's save lands; its reply is late
    b.annotation.editor.dispatch(mark(60)); // after A's change, on the revision A replaces
    release();
    await vi.advanceTimersByTimeAsync(1000); // A hears back; anything B saves is stale
    expect(remote.frames('rec')).toEqual([10]);

    // Tab B reloads: a new page, on the same journal, while tab A is still open.
    const reloaded = await new Sessions(journal, null).open('rec');
    await vi.advanceTimersByTimeAsync(1000);
    expect(remote.frames('rec')).toEqual([10]);
    expect(framesOf(reloaded)).toEqual([10]);
  });

  test('after the annotation files are deleted (history kept), saves go on top of the revision the server counts', async () => {
    const remote = server();
    const first = await new Sessions(null, null).open('rec-4');
    first.annotation.editor.dispatch(mark(10));
    await first.annotation.saver.flush(); // revision 1
    remote.deleteFiles('rec-4');
    // A reload: the old page, and its locks, are gone.
    vi.stubGlobal('navigator', { locks: browserLocks() });
    const again = await new Sessions(null, null).open('rec-4');
    again.annotation.editor.dispatch(mark(20));
    expect(await again.annotation.saver.flush()).toBe(true);
    expect(remote.ifMatch).toEqual(['"0"', '"1"']);
  });

  test('only the recording on screen and the one before it stay in memory, unless not saved yet', async () => {
    const remote = server();
    const sessions = new Sessions(null, null);
    const a = await sessions.open('rec-a');
    a.annotation.editor.dispatch(mark(10)); // not sent yet
    await sessions.open('rec-b');
    await sessions.open('rec-c');
    await vi.advanceTimersByTimeAsync(300);
    expect(remote.frames('rec-a')).toEqual([10]); // kept, so saved all the same
    await sessions.open('rec-d');
    expect((await sessions.open('rec-c')).fresh).toBe(false); // the one before
    expect((await sessions.open('rec-a')).fresh).toBe(true); // dropped once saved
  });

  test('a recording held (on screen, or for an Undo) stays in memory however many open after it', async () => {
    server();
    const sessions = new Sessions(null, null);
    const a = await sessions.open('rec-a');
    const release = sessions.hold('rec-a');
    await sessions.open('rec-b');
    await sessions.open('rec-c');
    expect((await sessions.open('rec-a')).annotation).toBe(a.annotation);
    release();
    await sessions.open('rec-b');
    await sessions.open('rec-c');
    expect((await sessions.open('rec-a')).fresh).toBe(true);
  });

  test('a recording that fails to open lets go of its lock, so another tab can edit it', async () => {
    server();
    const serve = globalThis.fetch;
    let failing = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (failing && url.includes('/api/recordings/rec-x'))
          throw new TypeError('Failed to fetch');
        return serve(url, init);
      }),
    );
    await expect(new Sessions(null, null).open('rec-x')).rejects.toThrow();
    failing = false;
    // Another tab of the same browser.
    expect((await new Sessions(null, null).open('rec-x')).annotation.openElsewhere).toBe(false);
  });
});
