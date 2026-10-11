import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SavePayload } from '../../../src/core/api-types.ts';
import { AnnotationSession } from '../../../src/web/annotation-session.ts';
import type { JournalEntry, UnsavedChanges } from '../../../src/web/journal.ts';
import type { LoadedRecording } from '../../../src/web/recording.ts';
import type { Telemetry } from '../../../src/web/telemetry.ts';
import { frameMap } from '../synthetic.ts';

const frames = frameMap(3_000_000_000_000n, new Array(199).fill(33_000));
const recording: LoadedRecording = {
  info: {
    id: 'rec',
    durationS: 6.6,
    cameras: [
      {
        name: 'umi.head.camera.enc',
        label: 'head',
        video: 'videos/head-0000.mp4',
        videoUrl: '/media/rec/videos/head-0000.mp4',
        framesUrl: '/media/rec/head-frames.csv',
        frameCount: 200,
        width: 640,
        height: 480,
      },
    ],
    thumbnails: null,
    task: null,
  },
  frames: [frames],
  seekable: true,
  saved: null,
  revision: 0,
  unsaved: null,
};

describe('annotation session', () => {
  let events: { event: string; [field: string]: unknown }[];
  let saves: SavePayload[];
  let session: AnnotationSession;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    events = [];
    saves = [];
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        saves.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ revision: saves.length }), { status: 200 });
      }),
    );
    const telemetry = {
      log: (_place: unknown, event: string, fields: Record<string, unknown> = {}) =>
        events.push({ event, ...fields }),
    } as unknown as Telemetry;
    session = new AnnotationSession(recording, null, telemetry);
  });
  afterEach(() => {
    session.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const accepted = () => events.filter((e) => e.event === 'boundary_accepted');

  test('a check is timed from landing on the rough mark to Enter, however it was moved', () => {
    const { editor } = session;
    editor.dispatch({ type: 'mark', frame: 100, state: 'keep', origin: 'live' });
    vi.advanceTimersByTime(5000); // still marking: not checking yet
    editor.dispatch({ type: 'select', frame: 100 }); // Enter lands on it
    vi.advanceTimersByTime(1000);
    editor.dispatch({ type: 'nudge', delta: -1, now: 0 });
    vi.advanceTimersByTime(1000);
    editor.dispatch({ type: 'nudge', delta: -1, now: 900 });
    vi.advanceTimersByTime(1000);
    editor.dispatch({ type: 'confirm', index: 0 }); // already checked: Enter still ends the visit
    expect(accepted()).toEqual([
      { event: 'boundary_accepted', frame: 100, how: 'nudge', check_ms: 3000 },
    ]);
  });

  test('a live mark is no visit; a drag counts from grabbing the handle to leaving', () => {
    const { editor } = session;
    editor.dispatch({ type: 'mark', frame: 100, state: 'keep', origin: 'live' });
    editor.dispatch({ type: 'confirm', index: 0 }); // confirmed at once, never visited
    editor.dispatch({ type: 'mark', frame: 150, state: 'cut', origin: 'live' });
    vi.advanceTimersByTime(4000);
    editor.dispatch({ type: 'drag-start', index: 1 });
    vi.advanceTimersByTime(2000);
    editor.dispatch({ type: 'move', index: 1, frame: 140 });
    editor.dispatch({ type: 'drag-end' });
    vi.advanceTimersByTime(1000);
    editor.dispatch({ type: 'select', frame: 100 }); // off to another boundary
    expect(accepted()).toEqual([
      { event: 'boundary_accepted', frame: 150, how: 'drag', check_ms: 3000 },
    ]);
  });

  test('a check that is undone, or a drag that is cancelled, is no check', () => {
    const { editor } = session;
    editor.dispatch({ type: 'mark', frame: 100, state: 'keep', origin: 'live' });
    editor.dispatch({ type: 'select', frame: 100 });
    editor.dispatch({ type: 'nudge', delta: -1, now: 0 });
    editor.dispatch({ type: 'undo' }); // rough again
    editor.dispatch({ type: 'drag-start', index: 0 });
    editor.dispatch({ type: 'move', index: 0, frame: 90 });
    editor.dispatch({ type: 'drag-cancel' }); // rough again
    editor.dispatch({ type: 'select', frame: null }); // leaves it
    expect(accepted()).toEqual([]);
    // Checked later with Enter: one acceptance, by Enter.
    editor.dispatch({ type: 'select', frame: 100 });
    vi.advanceTimersByTime(800);
    editor.dispatch({ type: 'confirm', index: 0 });
    expect(accepted()).toEqual([
      { event: 'boundary_accepted', frame: 100, how: 'enter', check_ms: 800 },
    ]);
  });

  test('active time counts while the screen is open, and the submit summary agrees with the save', async () => {
    const detach = session.attach(() => ({ frame: 20, playbackRate: 2 }));
    session.editor.dispatch({ type: 'mark', frame: 30, state: 'keep', origin: 'paused' });
    vi.advanceTimersByTime(10_000);
    expect(await session.finish({ type: 'submit' })).toBe(true);
    detach();
    const last = saves.at(-1)!;
    expect(last.annotation.status).toBe('complete');
    expect(last.sidecar.effort.active_ms).toBe(10_000);
    expect(last.sidecar.resume.frame).toBe(20);
    const submitted = events.find((e) => e.event === 'task_submitted');
    expect(submitted).toMatchObject({
      status: 'complete',
      n_intervals: 1,
      active_ms: last.sidecar.effort.active_ms,
      wall_ms: last.sidecar.effort.wall_ms,
    });
    expect(events.map((e) => e.event)).toContain('task_opened');
  });

  test('logging never gets in the way of saving', async () => {
    const telemetry = {
      log: () => {
        throw new TypeError('crypto.randomUUID is not a function');
      },
    } as unknown as Telemetry;
    const unlogged = new AnnotationSession(recording, null, telemetry);
    const mark = { type: 'mark', frame: 30, state: 'keep', origin: 'paused' } as const;
    expect(() => unlogged.editor.dispatch(mark)).not.toThrow();
    await vi.advanceTimersByTimeAsync(300);
    expect(saves).toHaveLength(1);
    unlogged.dispose();
  });

  test('holding a nudge key is journaled when it starts and when it is saved, not at every repeat', async () => {
    const written: JournalEntry[] = [];
    const journal: UnsavedChanges = {
      write: async (entry) => void written.push(entry),
      settle: async () => {},
      forget: async () => {},
    };
    const held = new AnnotationSession(recording, journal, null);
    held.editor.dispatch({ type: 'mark', frame: 100, state: 'keep', origin: 'paused' });
    await vi.advanceTimersByTimeAsync(300);
    written.length = 0;
    // . held for a second: the key repeats every 33 ms.
    for (let i = 0; i < 30; i++) {
      held.editor.dispatch({ type: 'nudge', delta: 1, now: i * 33 });
      await vi.advanceTimersByTimeAsync(33);
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(written).toHaveLength(2);
    expect(written.at(-1)?.payload.sidecar.boundaries[0]?.frame).toBe(130);
    expect(saves.at(-1)?.sidecar.boundaries[0]?.frame).toBe(130);
    held.dispose();
  });
});
