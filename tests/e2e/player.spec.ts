/** The player and its keys, checked against the barcodes on the synthetic clips. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import type { SavedAnnotation } from '../../src/core/api-types.ts';
import {
  displayedFrame,
  type FrameMap,
  frameNs,
  nearestFrame,
  parseFramesCsv,
} from '../../src/core/frame-map.ts';
import { shownFrame } from './barcode.ts';
import { E2E_DIR, SYNTHETIC_RECORDINGS, type SyntheticRecording } from './synthetic.ts';

const recording = SYNTHETIC_RECORDINGS[0] as SyntheticRecording;
const HEAD = 'video[data-camera="head"]';

async function cameraFrames(label: string): Promise<FrameMap> {
  const folder = join(E2E_DIR, 'data', recording.folder);
  const dir = recording.layout === 'split' ? join(folder, 'annotation-data') : folder;
  return parseFramesCsv(await readFile(join(dir, `${label}-frames.csv`), 'utf8'));
}

/** The saved boundaries, once there are `count` of them. */
async function savedBoundaries(page: Page, count: number) {
  let boundaries: readonly { frame: number; origin: string }[] = [];
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/annotations/${recording.id}`);
      const saved = response.ok() ? ((await response.json()) as SavedAnnotation) : null;
      boundaries = saved?.sidecar?.boundaries ?? [];
      return boundaries.length;
    })
    .toBe(count);
  return boundaries;
}

const revision = async (page: Page) =>
  (
    (await (await page.request.get(`/api/annotations/${recording.id}`)).json()) as {
      revision: number;
    }
  ).revision;

async function open(page: Page, frame: number) {
  await page.goto(`/#${recording.id}/${frame}`);
  await expect(page.locator(`.time[data-frame="${frame}"]`)).toBeVisible();
}

test('five quick → presses move exactly five frames', async ({ page }) => {
  await open(page, 100);
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('.time[data-frame="105"]')).toBeVisible();
  expect(await shownFrame(page, HEAD)).toBe(105);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(page.locator('.time[data-frame="95"]')).toBeVisible();
  expect(await shownFrame(page, HEAD)).toBe(95);
});

test('secondary cameras show their own frame nearest in source time, never the same index', async ({
  page,
}) => {
  const [head, left, right] = await Promise.all(['head', 'left', 'right'].map(cameraFrames));
  for (const frame of [37, 250, 512]) {
    await open(page, frame);
    const at = frameNs(head!, frame);
    for (const [label, frames] of [
      ['left', left!],
      ['right', right!],
    ] as const) {
      await expect
        .poll(() => shownFrame(page, `video[data-camera="${label}"]`))
        .toBe(nearestFrame(frames, at));
    }
  }
});

test('a side camera plays along, shows large on a click, and marks still come from the head', async ({
  page,
}) => {
  const [head, left] = await Promise.all(['head', 'left'].map(cameraFrames));
  await open(page, 60);
  await page.getByRole('button', { name: 'Show the left camera large' }).click();
  await expect(page.locator('.camera-main video')).toHaveAttribute('data-camera', 'left');
  // The head camera is small now, and a click brings it back.
  await expect(page.getByRole('button', { name: 'Show the head camera large' })).toBeVisible();

  // While playing, the left camera shows new pictures (counted as the browser presents them).
  const presented = page.locator('video[data-camera="left"]').evaluate(
    (video: HTMLVideoElement) =>
      new Promise<number>((resolve) => {
        let count = 0;
        const counted = () => {
          count++;
          video.requestVideoFrameCallback(counted);
        };
        video.requestVideoFrameCallback(counted);
        setTimeout(() => resolve(count), 900);
      }),
  );
  await page.keyboard.press('Space');
  expect(await presented).toBeGreaterThan(10);
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  // Paused: the head camera's frame, and the left camera's frame nearest to it.
  const frame = Number(await page.locator('.time').getAttribute('data-frame'));
  expect(await shownFrame(page, HEAD)).toBe(frame);
  await expect
    .poll(() => shownFrame(page, 'video[data-camera="left"]'))
    .toBe(nearestFrame(left!, frameNs(head!, frame)));
  await page.keyboard.press('s');
  const [mark] = await savedBoundaries(page, 1);
  expect(mark).toMatchObject({ frame, origin: 'paused' });
  await page.keyboard.press('ControlOrMeta+z');
  await savedBoundaries(page, 0);
  await page.getByRole('button', { name: 'Show the head camera large' }).click();
  await expect(page.locator('.camera-main video')).toHaveAttribute('data-camera', 'head');
});

test('pausing snaps the picture, currentTime, the readout and the next mark to one frame', async ({
  page,
}) => {
  const head = await cameraFrames('head');
  await open(page, 0);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  const readout = Number(await page.locator('.time').getAttribute('data-frame'));
  expect(readout).toBeGreaterThan(20);
  expect(await shownFrame(page, HEAD)).toBe(readout);
  const currentTime = await page
    .locator(HEAD)
    .evaluate((video: HTMLVideoElement) => video.currentTime);
  expect(displayedFrame(head, 0, currentTime)).toBe(readout);
  await page.keyboard.press('s');
  const saved = await savedBoundaries(page, 1);
  expect(saved[0]).toMatchObject({ frame: readout, origin: 'paused' });
  await page.keyboard.press('ControlOrMeta+z');
  await savedBoundaries(page, 0);
});

test('the speed list, which sticks across a reload, and hold-to-skim', async ({ page }) => {
  await open(page, 0);
  const rate = () => page.locator(HEAD).evaluate((video: HTMLVideoElement) => video.playbackRate);
  const pick = async (speed: string) => {
    await page.locator('.speed').click();
    await page.getByRole('menuitemradio', { name: new RegExp(`^${speed}`) }).click();
  };
  await expect(page.locator('.speed')).toHaveText('2×');
  await pick('0.5×');
  await expect(page.locator('.speed')).toHaveText('0.5×');
  expect(await rate()).toBe(0.5);
  await pick('3×');
  expect(await rate()).toBe(3);
  await page.keyboard.down('f');
  await expect(page.locator('.speed')).toHaveText('6× skim');
  expect(await rate()).toBe(6);
  await page.keyboard.up('f');
  await expect(page.locator('.speed')).toHaveText('3×');
  expect(await rate()).toBe(3);
  await page.keyboard.press('Space');
  await page.reload();
  await expect(page.locator('.speed')).toHaveText('3×');
  await pick('2×');
});

test('the command menu finds and runs commands; buttons act like keys', async ({ page }) => {
  await open(page, 60);
  const menu = page.getByRole('dialog', { name: 'Command menu' });
  await page.keyboard.press('h');
  await expect(menu).toBeVisible();
  await page.keyboard.type('s'); // typed into the search, not a mark
  await page.keyboard.press('ControlOrMeta+k');
  await expect(menu).toBeHidden();
  await expect(page.locator('.state-chip')).toHaveAttribute('data-state', 'cut');
  // A click beside it closes it, as Escape does.
  await page.keyboard.press('ControlOrMeta+k');
  await page.mouse.click(5, 300);
  await expect(menu).toBeHidden();
  await page.getByRole('button', { name: 'Command menu' }).click();
  await page.keyboard.type('forward 10');
  await expect(menu.locator('.command')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(page.locator('.time[data-frame="70"]')).toBeVisible();
  await page.keyboard.press('ArrowLeft'); // the keys work again
  await expect(page.locator('.time[data-frame="69"]')).toBeVisible();
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.time[data-frame="60"]')).toBeVisible();

  await page.getByRole('button', { name: /^Start/ }).click();
  await expect(page.locator('.state-chip')).toHaveAttribute('data-state', 'keep');
  await page.keyboard.press('Space'); // a clicked button must not keep the focus that Space would press
  await expect(page.locator('.time')).not.toHaveAttribute('data-frame', '60');
  await page.keyboard.press('Space');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.state-chip')).toHaveAttribute('data-state', 'cut');
});

test('moving around never saves; only changes to the annotation do', async ({ page }) => {
  await open(page, 100);
  await page.keyboard.press('s');
  await savedBoundaries(page, 1);
  const before = await revision(page);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('BracketLeft');
  await page.keyboard.press('BracketRight');
  await page.waitForTimeout(700);
  expect(await revision(page)).toBe(before);
  await page.keyboard.press('ControlOrMeta+z');
  await savedBoundaries(page, 0);
});

test('an edit made just before a reload is not lost', async ({ page }) => {
  await open(page, 120);
  await page.keyboard.press('s');
  await page.reload();
  await savedBoundaries(page, 1);
  // The undo history belongs to the page that is gone: select the boundary and delete it.
  await page.evaluate((id) => {
    location.hash = `${id}/121`;
  }, recording.id);
  await expect(page.locator('.time[data-frame="121"]')).toBeVisible();
  await page.keyboard.press('BracketLeft');
  await expect(page.locator('.time[data-frame="120"]')).toBeVisible();
  await page.keyboard.press('Backspace');
  await savedBoundaries(page, 0);
});

test('a reload reopens where the annotator was, not at the old link', async ({ page }) => {
  await open(page, 150);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('.time[data-frame="153"]')).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe(`#${recording.id}`);
  await page.reload();
  await expect(page.locator('.time[data-frame="153"]')).toBeVisible();
});

test('a link to another recording opens it', async ({ page }) => {
  await open(page, 10);
  const other = SYNTHETIC_RECORDINGS[1] as SyntheticRecording;
  await page.evaluate((hash) => {
    location.hash = hash;
  }, `${other.id}/20`);
  await expect(page.locator('.recording-id')).toHaveText(other.id);
  await expect(page.locator('.time[data-frame="20"]')).toBeVisible();
});

test('Space at the last frame stays there instead of starting over', async ({ page }) => {
  const last = recording.headFrames - 1;
  await open(page, last);
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  expect(Number(await page.locator('.time').getAttribute('data-frame'))).toBeGreaterThan(last - 3);
});

test('after the command menu closes, Space plays again (focus is handed back)', async ({
  page,
}) => {
  await open(page, 30);
  await page.keyboard.press('h');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Mute the ticks' })).toBeVisible();
  await expect(page.locator('.time')).not.toHaveAttribute('data-frame', '30');
  await page.keyboard.press('Space');
});
