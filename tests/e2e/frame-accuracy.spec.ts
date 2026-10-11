/**
 * The frame you see is the frame you save. Every frame of the synthetic clips shows its own index
 * as a barcode, so these tests compare what the browser displays with what the server stores.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import type { SavedAnnotation } from '../../src/core/api-types.ts';
import { type FrameMap, frameCount, parseFramesCsv } from '../../src/core/frame-map.ts';
import { BARCODE_PIXELS, decodeBarcode, shownFrame } from './barcode.ts';
import { resetAll } from './server-state.ts';
import { E2E_DIR, SYNTHETIC_RECORDINGS, type SyntheticRecording } from './synthetic.ts';

const [longer, shorter] = SYNTHETIC_RECORDINGS as [SyntheticRecording, SyntheticRecording];

test.beforeEach(({ request }) => resetAll(request));
const HEAD = 'video[data-camera="head"]';

async function headFrames(recording: SyntheticRecording): Promise<FrameMap> {
  const folder = join(E2E_DIR, 'data', recording.folder);
  const dir = recording.layout === 'split' ? join(folder, 'annotation-data') : folder;
  return parseFramesCsv(await readFile(join(dir, 'head-frames.csv'), 'utf8'));
}

/** The saved annotation once it holds `boundaries` boundaries. */
async function savedWith(
  page: Page,
  recording: SyntheticRecording,
  boundaries: number,
): Promise<SavedAnnotation> {
  let saved: SavedAnnotation | null = null;
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/annotations/${recording.id}`);
      saved = response.ok() ? ((await response.json()) as SavedAnnotation) : null;
      return saved?.sidecar?.boundaries.length ?? 0;
    })
    .toBe(boundaries);
  return saved!;
}

/** `count` distinct frames in [0, max], ascending, from a seeded generator (mulberry32). */
function randomFrames(count: number, max: number, seed: number): number[] {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const picked = new Set<number>();
  while (picked.size < count) picked.add(Math.floor(next() * (max + 1)));
  return [...picked].sort((a, b) => a - b);
}

/** Alternate S and D at increasing frames: each press starts a run, so keep intervals pair them. */
function expectedIntervals(marks: readonly number[], frames: FrameMap) {
  const intervals = [];
  for (let i = 0; i + 1 < marks.length; i += 2) {
    intervals.push({
      start_ns: String(frames.tsNs[marks[i]!]),
      end_ns: String(frames.tsNs[marks[i + 1]!]),
    });
  }
  return intervals;
}

test('a mark made while paused saves the timestamp of the frame on screen', async ({ page }) => {
  const recording = shorter;
  const frames = await headFrames(recording);
  const targets = randomFrames(200, frameCount(frames) - 1, 7);
  await page.goto(`/#${recording.id}`);
  await expect(page.locator('.time[data-frame="0"]')).toBeVisible();

  for (const [i, frame] of targets.entries()) {
    await page.evaluate((hash) => {
      location.hash = hash;
    }, `${recording.id}/${frame}`);
    await expect(page.locator(`.time[data-frame="${frame}"]`)).toBeVisible();
    expect(await shownFrame(page, HEAD), `pixels at frame ${frame}`).toBe(frame);
    await page.keyboard.press(i % 2 === 0 ? 's' : 'd');
  }

  const { annotation, sidecar } = await savedWith(page, recording, targets.length);
  expect(sidecar?.boundaries.map((b) => b.frame)).toEqual(targets);
  expect(sidecar?.boundaries.every((b) => b.origin === 'paused' && b.checked)).toBe(true);
  expect(annotation.keep_intervals).toEqual(expectedIntervals(targets, frames));
});

test('a mark made during 2× playback saves the last frame shown at the key press', async ({
  page,
}) => {
  const recording = longer;
  const frames = await headFrames(recording);
  // Before the app's own key listener: sample the barcode of the picture at each S/D press.
  await page.addInitScript((pixels) => {
    const samples: number[][] = [];
    Object.assign(window, { keyPressSamples: samples });
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 's' && event.key !== 'd') return;
        const video = document.querySelector<HTMLVideoElement>('video[data-camera="head"]');
        if (!video) return;
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        context.drawImage(video, 0, 0);
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        samples.push(
          pixels.map(([x, y]) => {
            const i = 4 * (y * canvas.width + x);
            return 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
          }),
        );
      },
      { capture: true },
    );
  }, BARCODE_PIXELS);

  await page.goto(`/#${recording.id}`);
  await expect(page.locator('.time[data-frame="0"]')).toBeVisible();
  await expect(page.locator('.speed')).toHaveText('2×');

  // Two passes over the clip. Presses are spaced past the longest frame gap (101 ms of video,
  // about 50 ms at 2×), so each lands on a new frame.
  const pressesPerPass = 100;
  for (const pass of [0, 1]) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(200 + 50 * pass);
    for (let i = 0; i < pressesPerPass; i++) {
      await page.keyboard.press(i % 2 === 0 ? 's' : 'd');
      await page.waitForTimeout(60 + ((i * 7) % 4) * 5);
    }
    await page.keyboard.press('Space');

    const samples = await page.evaluate(() => {
      const recorded = (window as unknown as { keyPressSamples: number[][] }).keyPressSamples;
      return recorded.splice(0);
    });
    const seen = samples.map(decodeBarcode);
    const { annotation, sidecar } = await savedWith(page, recording, pressesPerPass);
    const marked = sidecar?.boundaries.map((b) => b.frame) ?? [];
    // During playback no browser API names the frame on screen exactly: the frame callback for
    // the newest picture can still be pending at the key press. A live mark is the last frame
    // reported, so it is never ahead of the picture but may trail it by a few frames when the
    // page is busy (measured: 70–96% exact, at most 3 behind). Live marks are rough anyway —
    // reaction time is 15+ frames at 2× — and the check pass makes them exact.
    const lag = marked.map((frame, i) => (seen[i] ?? Number.NaN) - frame);
    const spread = Object.entries(Object.groupBy(lag, String)).map(
      ([d, xs]) => `${d}: ${xs?.length}`,
    );
    console.log(`pass ${pass}: picture − mark per press → ${spread.join(', ')}`);
    test.info().annotations.push({
      type: `pass ${pass}: picture − mark (frames)`,
      description: spread.join(', '),
    });
    expect(
      lag.every((d) => d >= 0 && d <= 5),
      `picture − mark per press: ${spread.join(', ')}`,
    ).toBe(true);
    expect(sidecar?.boundaries.every((b) => b.origin === 'live' && !b.checked)).toBe(true);
    expect(annotation.keep_intervals).toEqual(expectedIntervals(marked, frames));

    // Start the next pass from a clean timeline at the first frame.
    for (let i = 0; i < pressesPerPass; i++) await page.keyboard.press('ControlOrMeta+z');
    await savedWith(page, recording, 0);
    await page.evaluate(
      (hash) => {
        location.hash = hash;
      },
      `${recording.id}/${pass + 1}`,
    );
    await expect(page.locator(`.time[data-frame="${pass + 1}"]`)).toBeVisible();
  }
});
