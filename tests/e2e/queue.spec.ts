/** Moving through the queue: outcomes, the next recording, crash recovery. */
import { expect, type Page, test } from '@playwright/test';
import { resetAnnotation, savedAnnotation as saved } from './server-state.ts';
import { SYNTHETIC_RECORDINGS, type SyntheticRecording } from './synthetic.ts';

const [first, second] = SYNTHETIC_RECORDINGS.slice(3) as [SyntheticRecording, SyntheticRecording];

async function open(page: Page, id: string, frame: number) {
  await page.goto(`/#${id}/${frame}`);
  await expect(page.locator('.recording-id')).toHaveText(id);
  await expect(page.locator(`.time[data-frame="${frame}"]`)).toBeVisible();
}

/** Marks keep from `from` and cut from `to`, both while paused (exact, nothing to check). */
async function markInterval(page: Page, from: number, to: number) {
  await page.evaluate(
    (hash) => {
      location.hash = hash;
    },
    `${page.url().split('#')[1]?.split('/')[0]}/${from}`,
  );
  await expect(page.locator(`.time[data-frame="${from}"]`)).toBeVisible();
  await page.keyboard.press('s');
  for (let frame = from; frame < to; frame++) await page.keyboard.press('ArrowRight');
  await expect(page.locator(`.time[data-frame="${to}"]`)).toBeVisible();
  await page.keyboard.press('d');
}

// Every recording starts as an empty draft, so the queue order is known.
test.beforeEach(async ({ request }) => {
  for (const recording of SYNTHETIC_RECORDINGS) await resetAnnotation(request, recording.id);
});

test('⌘↵ saves the annotation as complete and the next recording opens within 300 ms', async ({
  page,
}) => {
  await open(page, first.id, 0);
  await markInterval(page, 10, 30);
  await expect(page.locator('.queue-bar')).toContainText('next ready');
  const elapsed = page.evaluate(
    (next) =>
      new Promise<number>((resolve) => {
        let start = 0;
        window.addEventListener(
          'keydown',
          (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
              start = performance.now();
          },
          { capture: true },
        );
        const poll = () => {
          const id = document.querySelector('.recording-id')?.textContent;
          const frame = Number(document.querySelector('.time')?.getAttribute('data-frame'));
          if (start > 0 && id === next && frame >= 0) resolve(performance.now() - start);
          else requestAnimationFrame(poll);
        };
        poll();
      }),
    second.id,
  );
  await page.keyboard.press('ControlOrMeta+Enter');
  const ms = await elapsed;
  console.log(`next recording on screen ${Math.round(ms)} ms after ⌘↵`);
  expect(ms).toBeLessThan(300);
  await expect(page.locator('.toast')).toContainText(`Submitted ${first.id}`);
  const result = await saved(page.request, first.id);
  expect(result?.annotation.status).toBe('complete');
  expect(result?.annotation.keep_intervals).toHaveLength(1);
});

test('⌘↵ with rough marks left goes to the first one instead of submitting', async ({ page }) => {
  await open(page, first.id, 20);
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  await page.keyboard.press('s');
  await page.waitForTimeout(500);
  await page.keyboard.press('d');
  await page.keyboard.press('Space');
  await expect
    .poll(async () => (await saved(page.request, first.id))?.sidecar?.boundaries.length)
    .toBe(2);
  const rough = (await saved(page.request, first.id))!.sidecar!.boundaries[0]!.frame;
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator(`.time[data-frame="${rough}"]`)).toBeVisible();
  await expect(page.locator('.toast')).toContainText('2 rough marks to check');
  await expect(page.locator('.recording-id')).toHaveText(first.id);
  expect((await saved(page.request, first.id))?.annotation.status).toBe('not_reviewed');
});

test('a keep running to the end of the video asks before submitting', async ({ page }) => {
  await open(page, first.id, 100);
  await page.keyboard.press('s');
  await page.keyboard.press('ControlOrMeta+Enter');
  const question = page.getByRole('alertdialog');
  await expect(question).toContainText('end of the video');
  await page.keyboard.press('Escape');
  await expect(question).toBeHidden();
  await expect(page.locator('.recording-id')).toHaveText(first.id);
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.keyboard.press('Enter');
  await expect(page.locator('.recording-id')).toHaveText(second.id);
  const result = await saved(page.request, first.id);
  expect(result?.annotation.status).toBe('complete');
  expect(result?.annotation.keep_intervals[0]?.end_ns).toBeDefined();
});

test('N cuts everything after a confirm; Undo on the toast brings the intervals back', async ({
  page,
}) => {
  await open(page, first.id, 0);
  await markInterval(page, 10, 20);
  await page.keyboard.press('n');
  await expect(page.getByRole('alertdialog')).toContainText('No useful task');
  await page.keyboard.press('Enter');
  await expect(page.locator('.recording-id')).toHaveText(second.id);
  const result = await saved(page.request, first.id);
  expect(result?.annotation).toMatchObject({ status: 'complete', keep_intervals: [] });

  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.recording-id')).toHaveText(first.id);
  await expect(page.locator('.intervals .interval')).toHaveCount(1);
  await expect
    .poll(async () => (await saved(page.request, first.id))?.annotation.status)
    .toBe('not_reviewed');
  expect((await saved(page.request, first.id))?.annotation.keep_intervals).toHaveLength(1);
});

test('Q: a reason and a note, then the queue moves on', async ({ page }) => {
  await open(page, first.id, 0);
  await markInterval(page, 10, 20);
  await page.keyboard.press('q');
  const dialog = page.getByRole('dialog', { name: 'Needs review' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('2');
  await page.keyboard.type('ends mid-fold');
  await page.keyboard.press('Enter');
  await expect(page.locator('.recording-id')).toHaveText(second.id);
  const result = await saved(page.request, first.id);
  expect(result?.annotation).toMatchObject({
    status: 'needs_review',
    notes: 'Unfinished task: ends mid-fold',
  });
  expect(result?.sidecar?.review_reason).toBe('unfinished_task');
});

test('the queue shows every recording and opens the one picked', async ({ page }) => {
  await open(page, first.id, 0);
  await page.getByRole('button', { name: 'Queue' }).click();
  const queue = page.getByRole('dialog', { name: 'Queue' });
  await expect(queue.locator('.queue-item')).toHaveCount(SYNTHETIC_RECORDINGS.length);
  await queue.getByRole('button', { name: new RegExp(second.id) }).click();
  await expect(page.locator('.recording-id')).toHaveText(second.id);
  await expect(queue).toBeHidden();
});

test('an edit that never reached the server is recovered after the tab is killed', async ({
  page,
  context,
}) => {
  await open(page, first.id, 40);
  // The server stops answering saves: the edit only exists in the page and its journal.
  await page.route('**/api/annotations/**', (route) =>
    route.request().method() === 'PUT' ? route.abort() : route.continue(),
  );
  await page.keyboard.press('s');
  await expect(page.locator('.save-chip')).toHaveAttribute('data-save', 'offline');
  // A crash: no pagehide, no last-moment save. The crash command itself never gets an answer.
  const crashed = page.waitForEvent('crash');
  void (await context.newCDPSession(page)).send('Page.crash').catch(() => {});
  await crashed;
  await page.close();
  expect((await saved(context.request, first.id))?.sidecar?.boundaries ?? []).toEqual([]);

  const again = await context.newPage();
  await again.goto(`/#${first.id}`);
  await expect(again.locator('.toast')).toContainText('Recovered');
  await expect
    .poll(async () =>
      (await saved(context.request, first.id))?.sidecar?.boundaries.map((b) => b.frame),
    )
    .toEqual([40]);
});
