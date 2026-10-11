/** A head camera video that fails to load: nothing can be marked, and the screen says so. */
import { expect, test } from '@playwright/test';
import type { RecordingResponse } from '../../src/core/api-types.ts';
import { resetAll, savedAnnotation } from './server-state.ts';
import { SYNTHETIC_RECORDINGS, type SyntheticRecording } from './synthetic.ts';

const recording = SYNTHETIC_RECORDINGS[3] as SyntheticRecording;

test.beforeEach(({ request }) => resetAll(request));

test('a head video that fails to load turns marking off, with a banner', async ({ page }) => {
  const response = await page.request.get(`/api/recordings/${recording.id}`);
  const head = ((await response.json()) as RecordingResponse).cameras[0]!.videoUrl;
  // Only the video element's requests fail: the server itself still answers byte ranges.
  await page.route(`**${head}`, (route) =>
    route.request().resourceType() === 'media' ? route.fulfill({ status: 404 }) : route.fallback(),
  );
  const boundaries = async () =>
    (await savedAnnotation(page.request, recording.id))?.sidecar?.boundaries ?? [];
  const before = await boundaries();

  // A link to frame 40: the seek there can never finish.
  await page.goto(`/#${recording.id}/40`);
  await expect(page.getByRole('alert').filter({ hasText: 'Marking is off' })).toBeVisible();
  await page.keyboard.press('s');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('d');
  await page.waitForTimeout(700);
  expect(await boundaries()).toEqual(before);
});
