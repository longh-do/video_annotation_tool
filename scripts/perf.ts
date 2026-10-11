/// <reference lib="dom" />
/**
 * Performance check on the longest recording, the way the 42-minute session will be annotated:
 * the production build, a few hundred boundaries, 2× playback. It reports how smoothly the page
 * draws (frame intervals, long tasks) and how many video frames are shown per second.
 *
 *   pnpm build && pnpm perf [--catalog derived/catalog.json] [--boundaries 320] [--seconds 20]
 *
 * Needs the real recordings ingested; annotations go to a temporary folder, not the real ones.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { type Browser, chromium } from '@playwright/test';
import { keepIntervals, sidecarBoundaries } from '../src/core/annotation.ts';
import { frameCount, parseFramesCsv } from '../src/core/frame-map.ts';
import type { Boundary, Timeline } from '../src/core/timeline.ts';
import { readCatalog, referenceCamera } from '../src/server/catalog.ts';
import { startServer } from './local-server.ts';

const { values } = parseArgs({
  options: {
    catalog: { type: 'string', default: 'derived/catalog.json' },
    boundaries: { type: 'string', default: '320' },
    seconds: { type: 'string', default: '20' },
  },
});
const PORT = 5179;
/** One frame at 60 Hz, with a little slack. */
const FRAME_BUDGET_MS = 17.5;
/** A bare <video> drops well under 1% at 2×; the page's own drawing must not add to that. */
const MAX_DROPPED = 0.02;

const catalog = await readCatalog(values.catalog);
const recording = catalog.recordings.toSorted((a, b) => b.durationS - a.durationS)[0];
if (!recording) throw new Error(`no recordings in ${values.catalog}`);
const camera = referenceCamera(recording);
const frames = parseFramesCsv(await readFile(camera.framesPath, 'utf8'));
const count = frameCount(frames);

// Boundaries spread over the recording, alternating keep and cut, all checked.
const n = Number(values.boundaries);
const boundaries: Boundary[] = Array.from({ length: n }, (_, i) => ({
  frame: Math.round(((i + 1) * count) / (n + 1)),
  state: i % 2 === 0 ? 'keep' : 'cut',
  origin: 'paused',
  checked: true,
}));
const timeline: Timeline = { frameCount: count, boundaries };

const server = await startServer(PORT, values.catalog);
const BASE = server.url;
let browser: Browser | null = null;
try {
  const saved = await fetch(`${BASE}/api/annotations/${encodeURIComponent(recording.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': '"0"' },
    body: JSON.stringify({
      annotation: {
        recording_id: recording.id,
        reference_video: camera.video,
        status: 'not_reviewed',
        keep_intervals: keepIntervals(timeline, frames),
        notes: '',
      },
      sidecar: {
        schema_version: 1,
        frame_count: count,
        boundaries: sidecarBoundaries(timeline, frames),
        review_reason: null,
        resume: { frame: 0, playback_rate: 2 },
        effort: { active_ms: 0, wall_ms: 0, edits: 0, undos: 0 },
      },
    }),
  });
  if (!saved.ok) throw new Error(`seeding the annotation failed: HTTP ${saved.status}`);

  browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const start = Math.round(count * 0.3);
  await page.goto(`${BASE}/#${encodeURIComponent(recording.id)}/${start}`);
  await page.locator(`.time[data-frame="${start}"]`).waitFor({ timeout: 60_000 });

  const measuring = page.evaluate((ms) => {
    const video = document.querySelector<HTMLVideoElement>('video[data-camera="head"]')!;
    const intervals: number[] = [];
    const slowFrames: number[] = [];
    let videoFrames = 0;
    // Frames that took more than 50 ms to produce, whatever kept the page busy.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) slowFrames.push(entry.duration);
    }).observe({ type: 'long-animation-frame' });
    const onVideoFrame = () => {
      videoFrames++;
      video.requestVideoFrameCallback(onVideoFrame);
    };
    video.requestVideoFrameCallback(onVideoFrame);
    const quality = video.getVideoPlaybackQuality();
    return new Promise<{
      intervals: number[];
      slowFrames: number[];
      videoFrames: number;
      dropped: number;
      decoded: number;
    }>((done) => {
      const began = performance.now();
      let last = began;
      const onFrame = (now: number) => {
        intervals.push(now - last);
        last = now;
        if (now - began < ms) {
          requestAnimationFrame(onFrame);
          return;
        }
        const after = video.getVideoPlaybackQuality();
        done({
          intervals,
          slowFrames,
          videoFrames,
          dropped: after.droppedVideoFrames - quality.droppedVideoFrames,
          decoded: after.totalVideoFrames - quality.totalVideoFrames,
        });
      };
      requestAnimationFrame(onFrame);
    });
  }, Number(values.seconds) * 1000);
  await page.keyboard.press('Space'); // plays at the default 2×
  const { intervals, slowFrames, videoFrames, dropped, decoded } = await measuring;
  await page.keyboard.press('Space');

  const sorted = intervals.slice(1).toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const missed = sorted.filter((ms) => ms > FRAME_BUDGET_MS * 1.5).length;
  const seconds = Number(values.seconds);
  console.log(`${recording.id}: ${count} frames, ${n} boundaries, ${seconds} s at 2×`);
  console.log(
    `page frames: ${sorted.length}, interval median ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, p99 ${at(0.99).toFixed(1)} ms, over 1.5 frames: ${missed} (${((100 * missed) / sorted.length).toFixed(1)}%)`,
  );
  console.log(
    `frames over 50 ms: ${slowFrames.length}, ${slowFrames.reduce((a, b) => a + b, 0).toFixed(0)} ms in all`,
  );
  console.log(
    `video: ${(decoded / seconds).toFixed(1)} frames/s decoded, ${dropped} dropped, frame callbacks ${(videoFrames / seconds).toFixed(1)}/s`,
  );
  const smooth = at(0.95) <= FRAME_BUDGET_MS;
  const videoKeptUp = dropped <= MAX_DROPPED * decoded;
  if (!smooth) console.log(`FAIL: p95 page frame interval above ${FRAME_BUDGET_MS} ms`);
  if (!videoKeptUp)
    console.log(`FAIL: the video dropped more than ${MAX_DROPPED * 100}% of its frames`);
  if (smooth && videoKeptUp) console.log('PASS: the page draws at 60 fps and the video keeps up');
  process.exitCode = smooth && videoKeptUp ? 0 : 1;
} finally {
  await browser?.close();
  await server.stop();
}
