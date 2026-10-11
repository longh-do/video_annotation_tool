/** Moving through the queue: outcomes, the next recording, crash recovery. */
import { expect, type Page, test } from '@playwright/test';
import { resetAll, savedAnnotation as saved } from './server-state.ts';
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
test.beforeEach(({ request }) => resetAll(request));

test('⌘↵ saves the annotation as complete and the next recording opens within 300 ms', async ({
  page,
}) => {
  await open(page, first.id, 0);
  await markInterval(page, 10, 30);
  await expect(page.locator('.queue-bar')).toHaveAttribute('data-next', 'ready');
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

test('⌘↵ with marks still to check warns: Enter goes to the first, ⌘↵ submits anyway', async ({
  page,
}) => {
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
  const unchecked = (await saved(page.request, first.id))!.sidecar!.boundaries[0]!.frame;
  await page.keyboard.press('ControlOrMeta+Enter');
  const question = page.getByRole('alertdialog');
  await expect(question).toContainText('2 marks still need checking');
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  await expect(question).toBeHidden();
  await expect(page.locator(`.time[data-frame="${unchecked}"]`)).toBeVisible();
  await expect(page.locator('.recording-id')).toHaveText(first.id);
  expect((await saved(page.request, first.id))?.annotation.status).toBe('not_reviewed');

  // A second ⌘↵ right after the first can't answer the question unread; a later one can.
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(question).toBeVisible();
  await page.waitForTimeout(600);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.recording-id')).toHaveText(second.id);
  const result = await saved(page.request, first.id);
  expect(result?.annotation.status).toBe('complete');
  expect(result?.sidecar?.boundaries.filter((b) => !b.checked)).toHaveLength(2);
});

test('a keep running to the end of the video asks before submitting', async ({ page }) => {
  await open(page, first.id, 100);
  await page.keyboard.press('s');
  await page.keyboard.press('ControlOrMeta+Enter');
  const question = page.getByRole('alertdialog');
  await expect(question).toContainText('The last interval has no stop');
  await page.keyboard.press('Escape');
  await expect(question).toBeHidden();
  await expect(page.locator('.recording-id')).toHaveText(first.id);
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.getByRole('button', { name: /Submit anyway/ }).click();
  await expect(page.locator('.recording-id')).toHaveText(second.id);
  const result = await saved(page.request, first.id);
  expect(result?.annotation.status).toBe('complete');
  expect(result?.annotation.keep_intervals[0]?.end_ns).toBeDefined();
});

test('a keep running to the end can go to review as an unfinished task, from the question', async ({
  page,
}) => {
  await open(page, first.id, 100);
  await page.keyboard.press('s');
  await page.keyboard.press('ControlOrMeta+Enter');
  const question = page.getByRole('alertdialog');
  await expect(
    question.getByRole('button', { name: /Needs review: unfinished task/ }),
  ).toBeVisible();
  // Its key, like the others in the question, answers it.
  await page.waitForTimeout(600);
  await page.keyboard.press('q');
  await expect(page.locator('.recording-id')).toHaveText(second.id);
  const result = await saved(page.request, first.id);
  expect(result?.annotation).toMatchObject({ status: 'needs_review', notes: 'Unfinished task' });
  expect(result?.sidecar?.review_reason).toBe('unfinished_task');
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
  await page.getByRole('button', { name: /Queue/ }).click();
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

test('⌘↵ on a recording with nothing kept asks, as N does; a second ⌘↵ never submits the next', async ({
  page,
}) => {
  await open(page, first.id, 0);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('alertdialog')).toContainText('No useful task');
  await page.keyboard.press('Escape');
  expect((await saved(page.request, first.id))?.annotation.status ?? 'not_reviewed').toBe(
    'not_reviewed',
  );

  await markInterval(page, 10, 20);
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.recording-id')).toHaveText(second.id);
  await page.waitForTimeout(500);
  expect((await saved(page.request, first.id))?.annotation.status).toBe('complete');
  expect((await saved(page.request, second.id))?.annotation.status ?? 'not_reviewed').toBe(
    'not_reviewed',
  );
});

test('keys pressed while an outcome is handed over do nothing', async ({ page }) => {
  await open(page, first.id, 0);
  await markInterval(page, 10, 20);
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.keyboard.press('Backspace'); // would delete the selected stop
  await expect(page.locator('.recording-id')).toHaveText(second.id);
  await page.waitForTimeout(500);
  expect((await saved(page.request, first.id))?.annotation).toMatchObject({
    status: 'complete',
    keep_intervals: [expect.anything()],
  });
});

test('in the review dialog, Enter on a reason picks it; it sends only from the note', async ({
  page,
}) => {
  await open(page, first.id, 0);
  await markInterval(page, 10, 20);
  await page.keyboard.press('q');
  await page.keyboard.press('1'); // the note field takes the focus
  await page.keyboard.press('Shift+Tab'); // back onto "Other"
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Needs review' })).toBeVisible();
  await page.keyboard.type('a third arm came in');
  await page.keyboard.press('Enter');
  await expect(page.locator('.recording-id')).toHaveText(second.id);
  const result = await saved(page.request, first.id);
  expect(result?.sidecar?.review_reason).toBe('other');
  expect(result?.annotation.notes).toBe('Other: a third arm came in');
});

test('a question waits while the queue is open, without taking its keys', async ({ page }) => {
  await open(page, first.id, 0);
  await markInterval(page, 10, 20);
  await page.keyboard.press('n');
  await page.getByRole('button', { name: /Queue/ }).click();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toContainText('No useful task');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toBeHidden();
  await expect(page.locator('.recording-id')).toHaveText(first.id);
  await expect(page.locator('.save-chip')).toHaveAttribute('data-save', 'saved');
  expect((await saved(page.request, first.id))?.annotation).toMatchObject({
    status: 'not_reviewed',
    keep_intervals: [expect.anything()],
  });
});

test('a question waits while the command menu is open: Enter there runs the command, not the answer', async ({
  page,
}) => {
  await open(page, first.id, 0);
  await markInterval(page, 10, 20);
  await page.keyboard.press('n');
  const question = page.getByRole('alertdialog');
  await expect(question).toContainText('No useful task');
  await page.getByRole('button', { name: 'Command menu' }).click();
  await expect(question).toBeHidden();
  await page.keyboard.type('forward 1 frame');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Command menu' })).toBeHidden();
  await expect(page.locator('.time[data-frame="21"]')).toBeVisible();
  // The question is back, still unanswered.
  await expect(question).toContainText('No useful task');
  await page.keyboard.press('Escape');
  await expect(question).toBeHidden();
  await expect(page.locator('.save-chip')).toHaveAttribute('data-save', 'saved');
  expect((await saved(page.request, first.id))?.annotation).toMatchObject({
    status: 'not_reviewed',
    keep_intervals: [expect.anything()],
  });
});

test('a recording that fails to open is reported, and the one on screen stays', async ({
  page,
}) => {
  await open(page, first.id, 0);
  await page.route(`**/api/annotations/${second.id}`, (route) => route.abort());
  await page.getByRole('button', { name: /Queue/ }).click();
  await page.getByRole('button', { name: new RegExp(second.id) }).click();
  await expect(page.locator('.toast')).toContainText(`Couldn't open ${second.id}`);
  await page.keyboard.press('Escape');
  await expect(page.locator('.recording-id')).toHaveText(first.id);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.time[data-frame="1"]')).toBeVisible();
});

test('two tabs on one recording: the stale one stops saving instead of overwriting', async ({
  page,
  browser,
}) => {
  await open(page, first.id, 30);
  await page.keyboard.press('s');
  await expect
    .poll(async () => (await saved(page.request, first.id))?.sidecar?.boundaries.length)
    .toBe(1);
  const other = await (await browser.newContext()).newPage();
  await open(other, first.id, 60);
  await other.keyboard.press('d');
  await expect
    .poll(async () => (await saved(page.request, first.id))?.sidecar?.boundaries.length)
    .toBe(2);

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('d');
  await expect(page.locator('.save-chip')).toHaveAttribute('data-save', 'conflict');
  await expect(page.getByRole('alert')).toContainText('saved from another tab');
  // The other tab's save stands.
  const frames = (await saved(page.request, first.id))?.sidecar?.boundaries.map((b) => b.frame);
  expect(frames).toEqual([30, 60]);
  await other.context().close();
});

test("if the outcome can't be saved, the recording stays and the keys come back", async ({
  page,
}) => {
  await open(page, first.id, 0);
  await markInterval(page, 10, 20);
  await expect(page.locator('.save-chip')).toHaveAttribute('data-save', 'saved');
  await page.route(`**/api/annotations/${first.id}`, (route) =>
    route.request().method() === 'PUT' ? route.abort() : route.continue(),
  );
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.toast')).toContainText('Not saved yet');
  await expect(page.locator('.recording-id')).toHaveText(first.id);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.time[data-frame="21"]')).toBeVisible();
  await page.unroute(`**/api/annotations/${first.id}`);
});

test('with nothing left to do, the queue opens after the last outcome', async ({ page }) => {
  for (const recording of SYNTHETIC_RECORDINGS.filter((r) => r.id !== first.id)) {
    const current = await saved(page.request, recording.id);
    const response = await page.request.put(`/api/annotations/${recording.id}`, {
      headers: { 'If-Match': `"${current?.revision ?? 0}"` },
      data: {
        annotation: {
          recording_id: recording.id,
          reference_video: 'videos/head-0000.mp4',
          status: 'complete',
          keep_intervals: [],
          notes: '',
        },
        sidecar: {
          schema_version: 1,
          frame_count: recording.headFrames,
          boundaries: [],
          review_reason: null,
          resume: { frame: 0, playback_rate: 2 },
          effort: { active_ms: 0, wall_ms: 0, edits: 0, undos: 0 },
        },
      },
    });
    expect(response.ok()).toBe(true);
  }
  await open(page, first.id, 0);
  await markInterval(page, 10, 20);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('dialog', { name: 'Queue' })).toBeVisible();
  await expect(page.locator('.recording-id')).toHaveText(first.id);
});

test('Back on the toast while the next recording loads returns at once, keys working', async ({
  page,
}) => {
  await open(page, first.id, 0);
  await markInterval(page, 10, 20);
  // The next recording takes a while to load.
  await page.route(`**/api/annotations/${second.id}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue().catch(() => {});
  });
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.locator('.toast').getByRole('button', { name: 'Back' }).click();
  // Back to work well before the slow load would have finished.
  await expect(page.locator('.workspace')).not.toHaveAttribute('inert', { timeout: 1000 });
  await expect(page.locator('.recording-id')).toHaveText(first.id);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.time[data-frame="21"]')).toBeVisible();
  // When the slow load finishes, it doesn't take over.
  await page.waitForTimeout(3000);
  await expect(page.locator('.recording-id')).toHaveText(first.id);
});

test('a link followed while the first recording loads opens the link, without an error', async ({
  page,
}) => {
  await page.route(`**/api/annotations/${first.id}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue().catch(() => {});
  });
  await page.goto(`/#${first.id}/0`);
  await page.waitForTimeout(300);
  await page.evaluate((hash) => {
    location.hash = hash;
  }, `${second.id}/5`);
  await expect(page.locator('.recording-id')).toHaveText(second.id);
  await page.waitForTimeout(2000);
  await expect(page.locator('.recording-id')).toHaveText(second.id);
  await expect(page.getByText("Couldn't load")).toHaveCount(0);
});
