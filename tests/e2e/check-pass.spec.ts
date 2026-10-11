/** The timelines and the check pass: marking at speed, then putting each mark on its frame. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type FrameMap, frameNs, parseFramesCsv } from '../../src/core/frame-map.ts';
import { shownFrame } from './barcode.ts';
import { resetAnnotation, savedAnnotation } from './server-state.ts';
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

/** Marks keep at 1.2 s and cut 1.5 s later, live at 2×: two rough marks to check. */
async function markLive(page: Page) {
  await open(page, 0);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.press('s');
  await page.waitForTimeout(1500);
  await page.keyboard.press('d');
  await page.waitForTimeout(300);
  await page.keyboard.press('Space');
  return savedWhen(page, (b) => b.length === 2);
}

const saved = (page: Page) => savedAnnotation(page.request, recording.id);

const boundariesOf = (annotation: Awaited<ReturnType<typeof saved>>): Boundary[] =>
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

/** The middle of a boundary's badge on the timeline, and the middle of the track below it. */
async function badgeAt(page: Page, frame: number) {
  const box = (await page.locator(`.tl-badge[data-frame="${frame}"]`).boundingBox())!;
  const track = (await page.locator('.timeline').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, trackY: track.y + 54 };
}

// Every test starts from an empty annotation of its own recording.
test.beforeEach(({ request }) => resetAnnotation(request, recording.id));

test('keyboard only: mark at 2×, then the check pass puts each rough mark on its frame', async ({
  page,
}) => {
  const [start, end] = await markLive(page);
  expect([start, end].map((b) => [b?.state, b?.origin, b?.checked])).toEqual([
    ['keep', 'live', false],
    ['cut', 'live', false],
  ]);
  await expect(page.locator('.check-status')).toContainText('2 marks need checking');

  // Enter lands on the first rough mark, paused, with the frames before it in the filmstrip.
  await page.keyboard.press('Enter');
  await expectShown(page, start!.frame);
  await expect(page.locator('.thumb-mark')).toHaveText('your mark');
  await expect(page.locator('.filmstrip legend')).toContainText(
    'Click the frame where the task really starts',
  );
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
  await step(async () => {
    // Right-click the first interval and merge it with the next: the cut from 80 to 119 goes.
    const [from, to] = [await badgeAt(page, 40), await badgeAt(page, 80)];
    await page.mouse.click((from.x + to.x) / 2, from.trackY, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Merge with the next interval' }).click();
  });
  await step(async () => {
    // Drag the start of the interval to the right by its badge.
    const badge = await badgeAt(page, 40);
    await page.mouse.move(badge.x, badge.y);
    await page.mouse.down();
    await page.mouse.move(badge.x + 30, badge.y, { steps: 5 });
    await page.mouse.up();
  });
  // A click on the stop's badge deletes it: the keep runs to the end.
  await step(() => page.locator('.tl-badge[data-frame="152"]').click());

  const last = states.at(-1)!;
  expect(last.map((b) => b.state)).toEqual(['keep']);
  expect(last[0]!.frame).toBeGreaterThan(40);
  expect(last[0]!.origin).toBe('drag');

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
  // Grab the boundary's edge on the track, not its badge.
  const badge = await badgeAt(page, 100);
  await page.mouse.move(badge.x, badge.trackY);
  await page.mouse.down();
  await page.mouse.move(badge.x + 60, badge.trackY, { steps: 5 });
  await expect(page.locator('.tl-badge[data-frame="100"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expectShown(page, 100);
  await expect(page.locator('.tl-badge-selected')).toHaveAttribute('data-frame', '100');
  await page.waitForTimeout(700);
  expect((await saved(page))!.revision).toBe(revision);
  expect(boundariesOf(await saved(page))).toEqual(before);
});

test('a very short run is pointed out, and one click takes it away', async ({ page }) => {
  await open(page, 200);
  await page.keyboard.press('s');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await expectShown(page, 204);
  await page.keyboard.press('d');
  await savedWhen(page, (b) => b.length === 2);
  await expect(page.getByRole('button', { name: /1 very short run/ })).toBeVisible();
  await page.keyboard.press('BracketLeft');
  await expectShown(page, 200);
  await expect(page.locator('.check-status')).toContainText('This keep lasts only');
  await page.getByRole('button', { name: 'Remove it' }).click();
  await expect(page.locator('.check-status')).not.toContainText('short');
  await expect.poll(async () => (await saved(page))?.annotation.keep_intervals).toEqual([]);
});

test('the interval list selects an interval; the task guide is one tab away', async ({ page }) => {
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
  await expect(intervals.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tl-badge-selected')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Task' }).click();
  const guideline = page.getByRole('tabpanel', { name: 'Task' });
  await expect(guideline.locator('h1')).toBeVisible();
  // Neither the panel nor a link in it takes the keyboard.
  await page.keyboard.press('Shift+ArrowRight');
  await expectShown(page, 70);
  await guideline.locator('a').first().click();
  await page.keyboard.press('Space');
  await expect(page.locator('.time')).not.toHaveAttribute('data-frame', '70');
  await page.keyboard.press('Space');
});

test('a long check pass keeps every filmstrip right, back to the first boundary', async ({
  page,
}) => {
  // The longest clip: enough marks that the first strips' thumbnails get released.
  const long = SYNTHETIC_RECORDINGS[0] as SyntheticRecording;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/#${long.id}/10`);
  await expect(page.locator('.time[data-frame="10"]')).toBeVisible();
  try {
    for (let i = 0; i < 24; i++) {
      const frame = 10 + i * 23;
      await page.evaluate((hash) => {
        location.hash = hash;
      }, `${long.id}/${frame}`);
      await expect(page.locator(`.time[data-frame="${frame}"]`)).toBeVisible();
      await page.keyboard.press(i % 2 === 0 ? 's' : 'd');
      await expect(page.locator('.thumb-mark')).toHaveAttribute(
        'title',
        new RegExp(`frame ${frame}$`),
      );
      // Every thumbnail grabbed before going on, so the cache really fills up.
      await expect(page.locator('.filmstrip .thumb-empty')).toHaveCount(0);
    }
    // Back to the first boundary: its strip's thumbnails were released long ago.
    await page.evaluate((hash) => {
      location.hash = hash;
    }, `${long.id}/0`);
    await expect(page.locator('.time[data-frame="0"]')).toBeVisible();
    await page.keyboard.press('BracketRight');
    await expect(page.locator('.time[data-frame="10"]')).toBeVisible();
    const thumbs = page.locator('.filmstrip .thumb');
    const count = await thumbs.count();
    for (let i = 0; i < count; i++) {
      const frame = Number((await thumbs.nth(i).getAttribute('title'))?.match(/\d+$/)?.[0]);
      await expect
        .poll(() => shownFrame(page, `.filmstrip .thumb:nth-of-type(${i + 1}) canvas`))
        .toBe(frame);
    }
    expect(errors).toEqual([]);
  } finally {
    // The other specs use this recording too: clean up once the last mark is on the server.
    await expect(page.locator('.save-chip')).toHaveAttribute('data-save', 'saved');
    await resetAnnotation(page.request, long.id);
  }
});
