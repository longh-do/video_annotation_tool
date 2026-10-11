/** The timeline and the mouse: zoom, selection, edges, badges, the menu, and annotating by mouse only. */
import { expect, type Page, test } from '@playwright/test';
import { resetAnnotation, savedAnnotation } from './server-state.ts';
import { SYNTHETIC_RECORDINGS, type SyntheticRecording } from './synthetic.ts';

const recording = SYNTHETIC_RECORDINGS[1] as SyntheticRecording;

async function open(page: Page, frame: number, id = recording.id) {
  await page.goto(`/#${id}/${frame}`);
  await expect(page.locator(`.time[data-frame="${frame}"]`)).toBeVisible();
}

async function goTo(page: Page, frame: number) {
  await page.evaluate((hash) => {
    location.hash = hash;
  }, `${recording.id}/${frame}`);
  await expect(page.locator(`.time[data-frame="${frame}"]`)).toBeVisible();
}

/** Keep [from, to), marked while paused. */
async function keep(page: Page, from: number, to: number) {
  await goTo(page, from);
  await page.keyboard.press('s');
  await goTo(page, to);
  await page.keyboard.press('d');
}

/** The saved boundaries as [frame, state], once `accept` is true of them. */
async function savedWhen(page: Page, accept: (boundaries: [number, string][]) => boolean) {
  let boundaries: [number, string][] = [];
  await expect
    .poll(async () => {
      const saved = await savedAnnotation(page.request, recording.id);
      boundaries = (saved?.sidecar?.boundaries ?? []).map((b) => [b.frame, b.state]);
      return accept(boundaries);
    })
    .toBe(true);
  return boundaries;
}

const savedAs = (page: Page, expected: [number, string][]) =>
  savedWhen(page, (b) => JSON.stringify(b) === JSON.stringify(expected));

/** Where a boundary is on the timeline (its badge), and the middle of the track. */
async function at(page: Page, frame: number) {
  const badge = (await page.locator(`.tl-badge[data-frame="${frame}"]`).boundingBox())!;
  const bar = (await page.locator('.timeline').boundingBox())!;
  return { x: badge.x + badge.width / 2, y: badge.y + badge.height / 2, track: bar.y + 54 };
}

const pixelRatio = (page: Page) => page.evaluate(() => window.devicePixelRatio);

test.beforeEach(({ request }) => resetAnnotation(request, recording.id));

test('⌘+ ⌘− zoom around the playhead, ⌘0 shows it all, ⌘-scroll zooms and a swipe pans', async ({
  page,
}) => {
  await open(page, 120);
  const ratio = await pixelRatio(page);
  const zoom = page.getByRole('slider', { name: 'Timeline zoom' });
  await expect(zoom).toHaveValue('0');
  await page.keyboard.press('ControlOrMeta+Equal');
  await page.keyboard.press('ControlOrMeta+Equal');
  const zoomed = Number(await zoom.inputValue());
  expect(zoomed).toBeGreaterThan(0);
  // The playhead was the anchor, so it is still in view.
  await expect(page.locator('.tl-playhead')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Minus');
  expect(Number(await zoom.inputValue())).toBeLessThan(zoomed);
  await page.keyboard.press('ControlOrMeta+Digit0');
  await expect(zoom).toHaveValue('0');

  // Ctrl + scroll is also how Chrome reports a trackpad pinch.
  const bar = (await page.locator('.timeline').boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y + 54);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await expect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(0);
  // A sideways swipe moves the view, so the playhead moves the other way on screen.
  await page.keyboard.press('ControlOrMeta+Equal'); // back around the playhead
  const before = (await page.locator('.tl-playhead').boundingBox())!.x;
  await page.mouse.wheel(60, 0);
  await expect
    .poll(async () => (await page.locator('.tl-playhead').boundingBox())?.x ?? 0)
    .toBeLessThan(before - 30);
  // None of this zoomed the page itself.
  expect(await pixelRatio(page)).toBe(ratio);
});

test('zoomed in, the view follows the playhead while playing, until it is scrolled by hand', async ({
  page,
}) => {
  const long = SYNTHETIC_RECORDINGS[0] as SyntheticRecording;
  await open(page, 0, long.id);
  for (let i = 0; i < 6; i++) await page.keyboard.press('ControlOrMeta+Equal');
  const playhead = page.locator('.tl-playhead');
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);
  // Well past the first page, and still in view: the view turned pages to keep up.
  expect(Number(await page.locator('.time').getAttribute('data-frame'))).toBeGreaterThan(60);
  await expect(playhead).toBeVisible();
  // Scrolled back by hand while playing: the view stays where it was sent.
  const bar = (await page.locator('.timeline').boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y + 54);
  await page.mouse.wheel(-5000, 0);
  await page.waitForTimeout(1000);
  await expect(playhead).toBeHidden();
  // Pausing shows where the video stopped.
  await page.keyboard.press('Space');
  await expect(playhead).toBeVisible();
});

test('a click on an interval selects it, here and in the list; near an edge the pointer is ↔', async ({
  page,
}) => {
  await open(page, 0);
  await keep(page, 60, 120);
  await savedAs(page, [
    [60, 'keep'],
    [120, 'cut'],
  ]);
  const [start, end] = [await at(page, 60), await at(page, 120)];
  const cursor = () => page.locator('.timeline').evaluate((e) => getComputedStyle(e).cursor);

  await page.mouse.move((start.x + end.x) / 2, start.track);
  expect(await cursor()).toBe('default');
  // Hovering shows the time (and a thumbnail) under the pointer.
  await expect(page.locator('.tl-preview')).toContainText(/\d:\d\d\.\d/);
  await page.mouse.click((start.x + end.x) / 2, start.track);
  await expect(page.locator('.intervals .interval').first()).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // The video shows the frame clicked, inside the interval.
  await expect
    .poll(async () => {
      const shown = Number(await page.locator('.time').getAttribute('data-frame'));
      return shown > 60 && shown < 120;
    })
    .toBe(true);

  await page.mouse.move(start.x + 2, start.track);
  expect(await cursor()).toBe('ew-resize');
  // Dragging the edge moves the start; the interval stays selected.
  await page.mouse.down();
  await page.mouse.move(start.x - 40, start.track, { steps: 4 });
  await page.mouse.up();
  const [moved] = await savedWhen(page, (b) => (b[0]?.[0] ?? 60) < 60);
  expect(moved?.[1]).toBe('keep');
  await expect(page.locator('.intervals .interval').first()).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('the right-click menu deletes, merges and keeps; a badge click deletes its boundary', async ({
  page,
}) => {
  await open(page, 0);
  await keep(page, 30, 60);
  await keep(page, 100, 140);
  await savedAs(page, [
    [30, 'keep'],
    [60, 'cut'],
    [100, 'keep'],
    [140, 'cut'],
  ]);
  const rightClick = async (from: number, to: number) => {
    const [a, b] = [await at(page, from), await at(page, to)];
    await page.mouse.click((a.x + b.x) / 2, a.track, { button: 'right' });
  };

  await rightClick(60, 100);
  await page.getByRole('menuitem', { name: 'Keep this part' }).click();
  await savedAs(page, [
    [30, 'keep'],
    [140, 'cut'],
  ]);
  await page.keyboard.press('ControlOrMeta+z');

  await rightClick(100, 140);
  await expect(page.getByRole('menuitem', { name: 'Merge with the next interval' })).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Merge with the previous interval' }).click();
  await savedAs(page, [
    [30, 'keep'],
    [140, 'cut'],
  ]);
  await page.keyboard.press('ControlOrMeta+z');

  await rightClick(100, 140);
  await page.getByRole('menuitem', { name: 'Delete interval' }).click();
  await expect(page.locator('.toast')).toContainText('Deleted the interval');
  await savedAs(page, [
    [30, 'keep'],
    [60, 'cut'],
  ]);

  await page.locator('.tl-badge[data-frame="60"]').click();
  await expect(page.locator('.toast')).toContainText('Deleted the boundary');
  await savedAs(page, [[30, 'keep']]);
  // The message's Undo brings it back; after any other edit it is gone, so it can't undo that.
  await page.locator('.toast').getByRole('button', { name: /Undo/ }).click();
  await savedAs(page, [
    [30, 'keep'],
    [60, 'cut'],
  ]);
  await page.locator('.tl-badge[data-frame="60"]').click();
  await expect(page.locator('.toast')).toBeVisible();
  await goTo(page, 90);
  await page.keyboard.press('d');
  await expect(page.locator('.toast')).toBeHidden();
  await page.keyboard.press('ControlOrMeta+z');
  await savedAs(page, [[30, 'keep']]);
  // Escape closes a menu without doing anything.
  const kept = await at(page, 30);
  await page.mouse.click(kept.x + 40, kept.track, { button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
});

test('mouse only: play, Start and Stop, check each mark, then Submit', async ({ page }) => {
  await open(page, 20);
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /^Start/ }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /^Stop/ }).click();
  await page.getByRole('button', { name: 'Pause' }).click();
  const marks = await savedWhen(page, (b) => b.length === 2);
  await expect(page.locator('.needs-check')).toBeVisible();

  await page.getByRole('button', { name: /Check the next mark/ }).click();
  await expect(page.locator(`.time[data-frame="${marks[0]![0]}"]`)).toBeVisible();
  await page.getByRole('button', { name: /Accept, go to the next/ }).click();
  await expect(page.locator(`.time[data-frame="${marks[1]![0]}"]`)).toBeVisible();
  await page.getByRole('button', { name: /Accept, go to the next/ }).click();
  await expect(page.locator('.check-status')).toContainText('Every boundary is checked');
  await expect(page.locator('.needs-check')).toHaveCount(0);

  // The other outcomes are one menu away.
  await page.getByRole('button', { name: 'Other outcomes' }).click();
  await page.getByRole('menuitem', { name: /No useful task/ }).click();
  await expect(page.getByRole('alertdialog')).toContainText('No useful task');
  await page.getByRole('button', { name: /^Back/ }).click();

  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.locator('.recording-id')).not.toHaveText(recording.id);
  const saved = await savedAnnotation(page.request, recording.id);
  expect(saved?.annotation.status).toBe('complete');
  expect(saved?.sidecar?.boundaries.every((b) => b.checked)).toBe(true);
});

test('the side panel gets wider by its edge, keeps that width, and a double click resets it', async ({
  page,
}) => {
  await open(page, 0);
  const panel = page.locator('.panel');
  const width = async () => (await panel.boundingBox())!.width;
  const normal = await width();
  const edge = (await page
    .getByRole('separator', { name: 'Resize the side panel' })
    .boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(edge.x - 150, edge.y + 200, { steps: 5 });
  await page.mouse.up();
  expect(await width()).toBeGreaterThan(normal + 140);
  await page.reload();
  await expect(page.locator('.time[data-frame]')).toBeVisible();
  expect(await width()).toBeGreaterThan(normal + 140);
  await page.getByRole('separator', { name: 'Resize the side panel' }).dblclick();
  expect(await width()).toBe(normal);
});

test("each recording shows its own task's guide, or says there is none", async ({ page }) => {
  await open(page, 0);
  await expect(page.locator('.task-name')).toHaveText('Example task for the tests');
  const unguided = SYNTHETIC_RECORDINGS[4] as SyntheticRecording;
  await open(page, 0, unguided.id);
  await expect(page.locator('.task-name')).toHaveText('No task guide');
  await page.getByRole('tab', { name: 'Task' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Task' })).toContainText(
    'No task guide covers this recording',
  );
  await page.getByRole('tab', { name: 'Guide' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Guide' }).locator('h1')).toHaveText(
    'How to annotate',
  );
});
