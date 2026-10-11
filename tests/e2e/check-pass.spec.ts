/** The timelines and the check pass: marking at speed, then putting each mark on its frame. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import type { SavedAnnotation } from '../../src/core/api-types.ts';
import { type FrameMap, frameNs, parseFramesCsv } from '../../src/core/frame-map.ts';
import { shownFrame } from './barcode.ts';
import { E2E_DIR, SYNTHETIC_RECORDINGS, type SyntheticRecording } from './synthetic.ts';

const recording = SYNTHETIC_RECORDINGS[2] as SyntheticRecording;
const HEAD = 'video[data-camera="head"]';

interface Boundary {
  readonly frame: number;
  readonly state: string;
  readonly origin: string;
  readonly checked: boolean;
}

async function headFrames(): Promise<FrameMap> {
  const csv = join(E2E_DIR, 'data', recording.folder, 'head-frames.csv');
  return parseFramesCsv(await readFile(csv, 'utf8'));
}

async function saved(page: Page): Promise<SavedAnnotation | null> {
  const response = await page.request.get(`/api/annotations/${recording.id}`);
  return response.ok() ? ((await response.json()) as SavedAnnotation) : null;
}

const boundariesOf = (annotation: SavedAnnotation | null): Boundary[] =>
  (annotation?.sidecar?.boundaries ?? []).map(({ frame, state, origin, checked }) => ({
    frame,
    state,
    origin,
    checked,
  }));

/** The saved boundaries, once `accept` is true of them. */
async function savedWhen(page: Page, accept: (boundaries: Boundary[]) => boolean) {
  let boundaries: Boundary[] = [];
  await expect
    .poll(async () => {
      boundaries = boundariesOf(await saved(page));
      return accept(boundaries);
    })
    .toBe(true);
  return boundaries;
}

/** Waits for the save after an edit: the saved boundaries change from `before`. */
const savedAfter = (page: Page, before: Boundary[]) =>
  savedWhen(page, (boundaries) => JSON.stringify(boundaries) !== JSON.stringify(before));

async function open(page: Page, frame: number) {
  await page.goto(`/#${recording.id}/${frame}`);
  await expect(page.locator(`.time[data-frame="${frame}"]`)).toBeVisible();
}

async function expectShown(page: Page, frame: number) {
  await expect(page.locator(`.time[data-frame="${frame}"]`)).toBeVisible();
  expect(await shownFrame(page, HEAD)).toBe(frame);
}

// Every test starts from an empty annotation of its own recording.
test.beforeEach(async ({ page }) => {
  const current = await saved(page);
  if (!current || current.annotation.keep_intervals.length + boundariesOf(current).length === 0) {
    return;
  }
  const frames = await headFrames();
  const response = await page.request.put(`/api/annotations/${recording.id}`, {
    headers: { 'If-Match': `"${current.revision}"` },
    data: {
      annotation: { ...current.annotation, status: 'not_reviewed', keep_intervals: [], notes: '' },
      sidecar: {
        schema_version: 1,
        frame_count: frames.ptsUs.length,
        boundaries: [],
        review_reason: null,
        resume: { frame: 0, playback_rate: 2 },
        effort: { active_ms: 0, wall_ms: 0, edits: 0, undos: 0 },
      },
    },
  });
  expect(response.ok()).toBe(true);
});

test('keyboard only: mark at 2×, then the check pass puts each rough mark on its frame', async ({
  page,
}) => {
  await open(page, 0);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.press('s');
  await page.waitForTimeout(1500);
  await page.keyboard.press('d');
  await page.waitForTimeout(300);
  await page.keyboard.press('Space');
  const [start, end] = await savedWhen(page, (b) => b.length === 2);
  expect([start, end].map((b) => [b?.state, b?.origin, b?.checked])).toEqual([
    ['keep', 'live', false],
    ['cut', 'live', false],
  ]);
  await expect(page.locator('.check-status')).toContainText('2 rough marks to check');

  // Enter lands on the first rough mark, paused, with the frames before it in the filmstrip.
  await page.keyboard.press('Enter');
  await expectShown(page, start!.frame);
  await expect(page.locator('.thumb-mark')).toHaveText('mark');
  await expect(page.locator('.thumb-boundary')).toHaveCount(1);

  // ← steps through exact frames; , nudges the boundary a frame earlier and shows it.
  await page.keyboard.press('ArrowLeft');
  await expectShown(page, start!.frame - 1);
  await page.keyboard.press('Comma');
  await page.keyboard.press('Comma');
  await expectShown(page, start!.frame - 2);
  // Enter accepts it and goes on to the next rough mark.
  await page.keyboard.press('Enter');
  await expectShown(page, end!.frame);
  await page.keyboard.press('Enter');
  await expect(page.locator('.check-status')).toContainText('Every boundary is checked');

  const checked = await savedWhen(page, (b) => b.every((boundary) => boundary.checked));
  expect(checked).toEqual([
    { frame: start!.frame - 2, state: 'keep', origin: 'nudge', checked: true },
    { frame: end!.frame, state: 'cut', origin: 'live', checked: true },
  ]);
  const frames = await headFrames();
  const annotation = (await saved(page))!.annotation;
  expect(annotation.keep_intervals).toEqual([
    {
      start_ns: String(frameNs(frames, start!.frame - 2)),
      end_ns: String(frameNs(frames, end!.frame)),
    },
  ]);
});

test('every filmstrip thumbnail shows its frame; clicking one moves the boundary there', async ({
  page,
}) => {
  await open(page, 120);
  await page.keyboard.press('s');
  await savedWhen(page, (b) => b.length === 1);
  const thumbs = page.locator('.filmstrip .thumb');
  await expect(thumbs.first()).toBeVisible();
  const count = await thumbs.count();
  expect(count).toBeGreaterThanOrEqual(10);
  for (let i = 0; i < count; i++) {
    const frame = Number((await thumbs.nth(i).getAttribute('title'))?.match(/\d+$/)?.[0]);
    await expect
      .poll(() => shownFrame(page, `.filmstrip .thumb:nth-of-type(${i + 1}) canvas`))
      .toBe(frame);
  }

  const first = Number((await thumbs.first().getAttribute('title'))?.match(/\d+$/)?.[0]);
  expect(first).toBeLessThan(120);
  await thumbs.first().click();
  await expectShown(page, first);
  const [moved] = await savedWhen(page, (b) => b[0]?.frame === first);
  expect(moved).toEqual({ frame: first, state: 'keep', origin: 'placed', checked: true });
  // The strip stays where it was, so the mark's thumbnail is still there to go back to.
  await expect(page.locator('.thumb-mark')).toHaveAttribute('title', /frame 120$/);
});

test('/ plays a second either side of the selected boundary, then comes back to it', async ({
  page,
}) => {
  await open(page, 150);
  await page.keyboard.press('s');
  await savedWhen(page, (b) => b.length === 1);
  await page.keyboard.press('Slash');
  await expect(page.locator('.time')).not.toHaveAttribute('data-frame', '150');
  // Two seconds of video at half speed, then back.
  await expect(page.locator('.time[data-frame="150"]')).toBeVisible({ timeout: 10_000 });
  await expectShown(page, 150);
  await expect(page.locator('.speed')).toHaveText('2×');
  expect(
    await page.evaluate((css) => document.querySelector<HTMLVideoElement>(css)!.paused, HEAD),
  ).toBe(true);
  expect(
    await page.evaluate((css) => document.querySelector<HTMLVideoElement>(css)!.playbackRate, HEAD),
  ).toBe(2);
});

test('boundary edits undo and redo exactly, step by step', async ({ page }) => {
  await open(page, 40);
  const states: Boundary[][] = [[]];
  /** Makes an edit and records what got saved; `done` says when the save is the final one. */
  const step = async (edit: () => Promise<void>, done?: (boundaries: Boundary[]) => boolean) => {
    await edit();
    states.push(await (done ? savedWhen(page, done) : savedAfter(page, states.at(-1)!)));
  };
  const go = async (keys: string[], frame: number) => {
    for (const key of keys) await page.keyboard.press(key);
    await expectShown(page, frame);
  };

  await step(() => page.keyboard.press('s')); // keep from 40
  await go(Array(4).fill('Shift+ArrowRight'), 80);
  await step(() => page.keyboard.press('d')); // cut from 80
  await go(Array(4).fill('Shift+ArrowRight'), 120);
  await step(() => page.keyboard.press('s')); // keep from 120
  await go(Array(3).fill('Shift+ArrowRight'), 150);
  await step(() => page.keyboard.press('d')); // cut from 150
  // A quick double nudge is one step.
  await step(
    async () => {
      await page.keyboard.press('Period');
      await page.keyboard.press('Period');
    },
    (b) => b[3]?.frame === 152,
  );
  await go(['BracketLeft'], 120);
  await step(() => page.keyboard.press('Comma')); // 120 → 119
  await go(Array(5).fill('ArrowLeft'), 114);
  await step(() => page.keyboard.press('t')); // the nearest boundary (119) moves to 114
  await go(['BracketLeft', 'BracketLeft'], 40);
  await step(() => page.keyboard.press('x')); // the keep from 40 becomes a cut
  await go(['BracketRight'], 80);
  await step(() => page.keyboard.press('Backspace')); // the cut from 80 goes
  await step(async () => {
    // Drag the keep from 114 a little to the left on the detail timeline.
    const handle = page.locator('.detail .handle[aria-valuenow="114"]');
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 30, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
  });

  expect(states.at(-1)!.map((b) => [b.frame, b.state])).toEqual([
    [40, 'cut'],
    [states.at(-1)![1]!.frame, 'keep'],
    [152, 'cut'],
  ]);
  expect(states.at(-1)![1]!.frame).toBeLessThan(114);
  expect(states.at(-1)![1]!.origin).toBe('drag');

  for (let i = states.length - 2; i >= 0; i--) {
    await page.keyboard.press('ControlOrMeta+z');
    await savedWhen(page, (b) => JSON.stringify(b) === JSON.stringify(states[i]));
  }
  for (let i = 1; i < states.length; i++) {
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await savedWhen(page, (b) => JSON.stringify(b) === JSON.stringify(states[i]));
  }
});

test('Escape during a drag puts the boundary back', async ({ page }) => {
  await open(page, 100);
  await page.keyboard.press('s');
  const before = await savedWhen(page, (b) => b.length === 1);
  const revision = (await saved(page))!.revision;
  const handle = page.locator('.detail .handle[aria-valuenow="100"]');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 5 });
  await expect(page.locator('.detail .handle[aria-valuenow="100"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expectShown(page, 100);
  await expect(page.locator('.detail .handle-selected')).toHaveAttribute('aria-valuenow', '100');
  await page.waitForTimeout(700);
  expect((await saved(page))!.revision).toBe(revision);
  expect(boundariesOf(await saved(page))).toEqual(before);
});

test('a very short run is pointed out, and X flips it away', async ({ page }) => {
  await open(page, 200);
  await page.keyboard.press('s');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await expectShown(page, 204);
  await page.keyboard.press('d');
  await savedWhen(page, (b) => b.length === 2);
  await page.getByRole('button', { name: /1 very short run/ }).click();
  await expectShown(page, 200);
  await expect(page.locator('.check-status')).toContainText('This keep lasts only');
  await page.keyboard.press('x');
  await expect(page.locator('.check-status')).not.toContainText('short');
  await expect.poll(async () => (await saved(page))?.annotation.keep_intervals).toEqual([]);
});

test('the interval list jumps to an interval; the guideline is one tab away', async ({ page }) => {
  await open(page, 60);
  await page.keyboard.press('s');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
  await expectShown(page, 90);
  await page.keyboard.press('d');
  await page.keyboard.press('Shift+ArrowRight');
  await expectShown(page, 100);
  const intervals = page.locator('.intervals .interval');
  await expect(intervals).toHaveCount(1);
  await intervals.first().click();
  await expectShown(page, 60);
  await expect(page.locator('.detail .handle-selected')).toHaveAttribute('aria-valuenow', '60');

  await page.getByRole('tab', { name: 'Guideline' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Guideline' }).locator('h1')).toBeVisible();
  // The panel never takes the keyboard.
  await page.keyboard.press('Shift+ArrowRight');
  await expectShown(page, 70);
});
