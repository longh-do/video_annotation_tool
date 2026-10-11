/**
 * Two tabs of one browser on one recording. They share the crash-recovery journal, so only one of
 * them may edit: the other opens the recording read-only until the first lets go of it.
 */
import { expect, type Page, test } from '@playwright/test';
import { resetAnnotation, savedAnnotation } from './server-state.ts';
import { SYNTHETIC_RECORDINGS, type SyntheticRecording } from './synthetic.ts';

const recording = SYNTHETIC_RECORDINGS[2] as SyntheticRecording;

async function open(page: Page, frame: number) {
  await page.goto(`/#${recording.id}/${frame}`);
  await expect(page.locator(`.time[data-frame="${frame}"]`)).toBeVisible();
}

async function goTo(page: Page, frame: number) {
  await page.evaluate((hash) => {
    location.hash = hash;
  }, `${recording.id}/${frame}`);
  await expect(page.locator(`.time[data-frame="${frame}"]`)).toBeVisible();
}

async function savedFrames(page: Page) {
  const saved = await savedAnnotation(page.request, recording.id);
  return (saved?.sidecar?.boundaries ?? []).map((b) => b.frame);
}

test.beforeEach(async ({ request }) => {
  await resetAnnotation(request, recording.id);
});

test('a second tab on the same recording is read-only until the first one closes', async ({
  page,
  context,
}) => {
  await open(page, 30);
  const second = await context.newPage();
  await open(second, 60);
  const banner = second.locator('.banner', { hasText: 'open in another tab' });
  await expect(banner).toBeVisible();
  await expect(page.locator('.banner')).toHaveCount(0);

  // Only the first tab's keys edit.
  await second.keyboard.press('s');
  await page.keyboard.press('s');
  await expect(page.locator('.save-chip')).toHaveAttribute('data-save', 'saved');
  await expect.poll(() => savedFrames(page)).toEqual([30]);
  await second.waitForTimeout(500);
  expect(await savedFrames(page)).toEqual([30]);
  await expect(second.locator('.intervals .interval')).toHaveCount(0);

  // Once the first tab is gone, a reload makes the second one the editor.
  await page.close();
  await banner.getByRole('button', { name: 'Reload' }).click();
  await expect(second.locator('.recording-id')).toHaveText(recording.id);
  await expect(second.locator('.intervals .interval')).toHaveCount(1);
  await expect(second.locator('.banner')).toHaveCount(0);
  await goTo(second, 80);
  await second.keyboard.press('d');
  await expect.poll(() => savedFrames(second)).toEqual([30, 80]);
});
