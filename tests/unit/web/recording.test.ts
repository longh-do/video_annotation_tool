import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RecordingResponse } from '../../../src/core/api-types.ts';
import { loadRecording, prefetchMedia } from '../../../src/web/recording.ts';
import { framesCsv } from '../synthetic.ts';

const csv = framesCsv([
  { file: 'head-0000.mp4', startNs: 3_000_000_000_000n, gapsUs: new Array(9).fill(33_000) },
]);

/**
 * A fake server: a range request for a video gets `videoStatus`, and nothing is saved (the 404
 * names `revision`, the number of saves whose files were deleted since).
 */
function server({ videoStatus = 206, revision = 0 } = {}) {
  /** The recordings whose media was fetched, in order. */
  const fetched: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const recording = url.split('/')[url.startsWith('/media/') ? 2 : 3]!;
      if (url.startsWith('/api/recordings/')) {
        fetched.push(recording);
        const info: RecordingResponse = {
          id: recording,
          durationS: 0.3,
          cameras: [
            {
              name: 'umi.head.camera.enc',
              label: 'head',
              video: 'videos/head-0000.mp4',
              videoUrl: `/media/${recording}/videos/head-0000.mp4`,
              framesUrl: `/media/${recording}/head-frames.csv`,
              frameCount: 10,
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
      if (url.endsWith('.mp4')) return new Response('vi', { status: videoStatus });
      if (url.startsWith('/api/annotations/')) return Response.json({ revision }, { status: 404 });
      throw new Error(`unexpected request ${url}`);
    }),
  );
  return fetched;
}

describe('recording', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('a video sent in byte ranges can be seeked; one only ever sent whole cannot', async () => {
    server({ videoStatus: 206 });
    expect((await loadRecording('ranges', null)).seekable).toBe(true);
    server({ videoStatus: 200 });
    expect((await loadRecording('whole', null)).seekable).toBe(false);
  });

  test("a missing video fails to open: it isn't a server that ignores byte ranges", async () => {
    server({ videoStatus: 404 });
    await expect(loadRecording('missing', null)).rejects.toThrow('HTTP 404');
  });

  test('with nothing saved, the revision to save on is the one the server counts', async () => {
    server({ revision: 3 });
    expect(await loadRecording('deleted', null)).toMatchObject({ saved: null, revision: 3 });
  });

  test('only the media of the last three recordings asked for stays in memory', async () => {
    const fetched = server();
    for (const id of ['m1', 'm2', 'm3', 'm4']) await prefetchMedia(id);
    await prefetchMedia('m2'); // the one before: still here
    await prefetchMedia('m1'); // dropped: fetched again
    expect(fetched).toEqual(['m1', 'm2', 'm3', 'm4', 'm1']);
  });
});
