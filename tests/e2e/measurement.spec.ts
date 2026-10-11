/** Measurement end to end: what the page logs is what `pnpm score` reports. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { AnnotationFile } from '../../src/core/annotation.ts';
import { frameNs, parseFramesCsv } from '../../src/core/frame-map.ts';
import { readCatalog } from '../../src/server/catalog.ts';
import { formatReport, scoreFolders } from '../../src/server/score-report.ts';
import { resetAnnotation, savedAnnotation } from './server-state.ts';
import { E2E_DIR, SYNTHETIC_RECORDINGS, type SyntheticRecording } from './synthetic.ts';

const recording = SYNTHETIC_RECORDINGS[4] as SyntheticRecording;
const TELEMETRY = join(E2E_DIR, 'telemetry', 'events.jsonl');

async function events(): Promise<
  { event: string; recording_id: string; [key: string]: unknown }[]
> {
  const text = await readFile(TELEMETRY, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => e.recording_id === recording.id);
}

test('marking, checking and submitting are logged; the score report measures them', async ({
  page,
  request,
}) => {
  await resetAnnotation(request, recording.id);
  await page.goto(`/#${recording.id}/0`);
  await expect(page.locator('.time[data-frame="0"]')).toBeVisible();

  // Mark live at 2×, check both rough marks (the first nudged), submit.
  await page.keyboard.press('Space');
  await page.waitForTimeout(700);
  await page.keyboard.press('s');
  await page.waitForTimeout(900);
  await page.keyboard.press('d');
  await page.waitForTimeout(200);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('video')?.paused);
  await expect
    .poll(async () => (await savedAnnotation(request, recording.id))?.sidecar?.boundaries.length)
    .toBe(2);
  const [start, end] = (await savedAnnotation(request, recording.id))!.sidecar!.boundaries;
  await page.keyboard.press('Enter'); // lands on the first rough mark
  await expect(page.locator(`.time[data-frame="${start!.frame}"]`)).toBeVisible();
  await page.waitForTimeout(400);
  await page.keyboard.press('Comma');
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter'); // accepts it, lands on the second
  await expect(page.locator(`.time[data-frame="${end!.frame}"]`)).toBeVisible();
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await expect(page.locator('.check-status')).toContainText('Every boundary is checked');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.recording-id')).not.toHaveText(recording.id);
  await page.close(); // sends what telemetry still holds

  await expect
    .poll(async () => (await events()).some((e) => e.event === 'task_submitted'))
    .toBe(true);
  const log = await events();
  const names = log.map((e) => e.event);
  for (const name of [
    'task_opened',
    'media_ready',
    'playback',
    'boundary_set',
    'boundary_adjusted',
  ]) {
    expect(names).toContain(name);
  }
  // Each check is timed from landing on the mark to the Enter that leaves it.
  const accepted = log.filter((e) => e.event === 'boundary_accepted');
  expect(accepted.map((e) => [e.frame, e.how])).toEqual([
    [start!.frame, 'nudge'],
    [end!.frame, 'enter'],
  ]);
  for (const { check_ms } of accepted) {
    expect(check_ms).toBeGreaterThanOrEqual(350);
    expect(check_ms).toBeLessThan(3000);
  }
  const submitted = log.find((e) => e.event === 'task_submitted')!;
  expect(submitted).toMatchObject({ status: 'complete', n_intervals: 1, max_rate: 2 });
  expect(typeof submitted.keep_ns_total).toBe('string');
  expect(submitted.active_ms).toBeGreaterThan(0);
  // A position once a frame is on screen; none before (the recording just opened).
  const ready = names.indexOf('media_ready');
  for (const event of log.slice(ready)) expect(typeof event.media_pos_ns).toBe('string');

  // Gold: the same interval, starting 3 frames earlier and ending 2 frames later.
  const saved = (await savedAnnotation(request, recording.id))!;
  const boundaries = saved.sidecar!.boundaries.map((b) => b.frame);
  const csv = join(E2E_DIR, 'data', recording.folder, 'head-frames.csv');
  const frames = parseFramesCsv(await readFile(csv, 'utf8'));
  const gold: AnnotationFile = {
    ...saved.annotation,
    keep_intervals: [
      {
        start_ns: String(frameNs(frames, boundaries[0]! - 3)),
        end_ns: String(frameNs(frames, boundaries[1]! + 2)),
      },
    ],
  };
  const goldDir = await mkdtemp(join(E2E_DIR, 'gold-'));
  await writeFile(join(goldDir, `${recording.id}.json`), JSON.stringify(gold));

  const catalog = await readCatalog(join(E2E_DIR, 'derived', 'catalog.json'));
  const report = await scoreFolders(goldDir, join(E2E_DIR, 'annotations'), catalog, TELEMETRY);
  const row = report.recordings.find((r) => r.id === recording.id)!;
  expect(row.score).toMatchObject({ startErrors: [3], endErrors: [-2], missed: 0, extra: 0 });
  expect(row.checkSeconds?.count).toBe(2);
  expect(row.activeS).toBeGreaterThan(0);
  expect(report.realTimeFactor).toBeGreaterThan(0);
  expect(formatReport(report)).toContain('s per check');
});
