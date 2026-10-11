import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Telemetry } from '../../../src/web/telemetry.ts';

const place = {
  recordingId: 'rec',
  guidelineVersion: 'sha256:0123456789ab',
  mediaPosNs: '3000000000000',
  playbackRate: 2,
};
const context = { annotatorId: 'a1', toolVersion: '0.1.0' };

describe('telemetry', () => {
  let posts: { events: { event: string }[]; keepalive: boolean }[];
  let beacons: Blob[];
  let online: boolean;
  let hide: () => void;
  let storage: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    posts = [];
    beacons = [];
    online = true;
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    vi.stubGlobal('document', { ...target, visibilityState: 'visible' });
    vi.stubGlobal('window', target);
    hide = () => listeners.get('pagehide')?.();
    // Like Chrome, beacons in flight share 64 KB: here the first one takes it all.
    vi.stubGlobal('navigator', {
      sendBeacon: (_url: string, blob: Blob) => beacons.length === 0 && beacons.push(blob) > 0,
    });
    storage = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        if (!online) throw new TypeError('Failed to fetch');
        posts.push({ events: JSON.parse(String(init.body)), keepalive: init.keepalive === true });
        return new Response(null, { status: 204 });
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('events go out in batches, with the envelope, and not as keepalive requests', async () => {
    const telemetry = new Telemetry(context);
    telemetry.log(place, 'task_opened', { revision: 3 });
    telemetry.log(place, 'boundary_set', { frame: 40 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.keepalive).toBe(false);
    expect(posts[0]?.events).toMatchObject([
      { event: 'task_opened', revision: 3, annotator_id: 'a1', recording_id: 'rec' },
      { event: 'boundary_set', frame: 40, media_pos_ns: '3000000000000', playback_rate: 2 },
    ]);
    telemetry.dispose();
  });

  test('a batch that does not get through is sent again, before what came since', async () => {
    const telemetry = new Telemetry(context);
    online = false;
    telemetry.log(place, 'save_failed');
    await vi.advanceTimersByTimeAsync(5000);
    online = true;
    telemetry.log(place, 'save_acked');
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts.map((p) => p.events.map((e) => e.event))).toEqual([['save_failed', 'save_acked']]);
    telemetry.dispose();
  });

  test('a closing page sends one beacon; the rest waits for the next page', async () => {
    const closing = new Telemetry(context);
    for (let i = 0; i < 250; i++) closing.log(place, 'playback', { i });
    hide();
    const [beacon] = await Promise.all(beacons.map(async (b) => JSON.parse(await b.text())));
    expect(beacon).toHaveLength(100);
    closing.dispose();

    const next = new Telemetry(context);
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts.map((p) => p.events.length)).toEqual([150]);
    expect(posts[0]?.events[0]).toMatchObject({ event: 'playback', i: 100 });
    expect(storage.size).toBe(0);
    next.dispose();
  });
});
