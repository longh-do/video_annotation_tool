/// <reference lib="dom" />
/**
 * The demo, played by the computer in a Chrome window: the tool goes through the steps of the
 * demo on the real recordings, with a caption for each step, for whoever presents or records it.
 * It starts its own server on a scratch annotations folder, so real work is never touched.
 *
 *   pnpm build && pnpm demo [--catalog derived/catalog.json]
 */
import { parseArgs } from 'node:util';
import { type Browser, chromium, type Page } from '@playwright/test';
import { readCatalog } from '../src/server/catalog.ts';
import { startServer } from './local-server.ts';

const { values } = parseArgs({
  options: {
    catalog: { type: 'string', default: 'derived/catalog.json' },
  },
});
const PORT = 5178;
const SIZE = { width: 1440, height: 900 };

const catalog = await readCatalog(values.catalog);
const [folding, second, , long] = catalog.recordings.map((r) => r.id);
if (!folding || !second || !long) throw new Error('the demo needs the four recordings ingested');

const server = await startServer(PORT, values.catalog);
const BASE = server.url;
let browser: Browser | null = null;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: SIZE });
  const page = await context.newPage();
  await page.goto(`${BASE}/#${folding}`);
  await page.locator('.time[data-frame="0"]').waitFor({ timeout: 60_000 });

  await caption(page, 'A queue of recordings; each opens where it was left');
  await page.getByRole('button', { name: /Queue/ }).click();
  await pause(2500);
  await page.keyboard.press('Escape');

  await caption(page, 'Watch at 2× and press S where the task starts, D where it ends');
  await page.keyboard.press('Space');
  await pressAt(page, 75, 's'); // a little after the first touch, as a person would
  await caption(page, 'Hold F to skim at 6× through what is obviously not the task');
  await page.keyboard.down('f');
  await waitForFrame(page, 2250);
  await page.keyboard.up('f');
  await caption(page, 'D too early? ⌘Z takes it back');
  await pressAt(page, 2300, 'd');
  await pause(600);
  await page.keyboard.press('ControlOrMeta+z');
  await pressAt(page, 2415, 'd');
  await page.keyboard.press('Space');

  await caption(page, 'Marks made while playing need a check: Enter lands on each one');
  await pause(1200);
  await page.keyboard.press('Enter');
  await pause(1800);
  await caption(page, 'Click the frame where the task really starts, then Enter');
  await page.locator('.filmstrip .thumb').nth(6).click(); // half a second before the mark
  await pause(1500);
  await page.keyboard.press('Enter');
  await pause(1500);
  await caption(page, ', and . move a boundary a frame at a time');
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Comma');
    await pause(250);
  }
  await page.keyboard.press('Enter');
  await pause(1200);

  await caption(page, 'Click an interval to select it; right-click it to merge or delete');
  const bar = (await page.locator('.timeline').boundingBox())!;
  const kept = (await page.locator('.tl-badge').first().boundingBox())!;
  await page.mouse.click(kept.x + 30, bar.y + 54);
  await pause(1200);
  await page.mouse.click(kept.x + 30, bar.y + 54, { button: 'right' });
  await pause(2500);
  await page.keyboard.press('Escape');

  await caption(page, '⌘↵ submits; the next recording, fetched ahead, opens at once');
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.locator('.recording-id', { hasText: second }).waitFor();
  await pause(2500);

  await caption(page, 'Q hands a recording to a reviewer, with a reason and a note');
  await page.keyboard.press('Space');
  await pressAt(page, 120, 's');
  await page.keyboard.press('Space');
  await page.keyboard.press('q');
  await pause(800);
  await page.keyboard.press('2');
  await page.keyboard.type('recording ends mid-fold', { delay: 60 });
  await pause(800);
  await page.keyboard.press('Enter');
  await pause(2000);

  await caption(page, 'The 42-minute session: thumbnails on hover, pinch or ⌘+ to zoom');
  await page.getByRole('button', { name: /Queue/ }).click();
  await page.getByRole('button', { name: new RegExp(long) }).click();
  await page.locator('.recording-id', { hasText: long }).waitFor();
  const timeline = (await page.locator('.timeline').boundingBox())!;
  for (let x = 0.1; x <= 0.9; x += 0.1) {
    await page.mouse.move(timeline.x + timeline.width * x, timeline.y + 54);
    await pause(250);
  }
  await page.mouse.move(0, 0);
  await page.evaluate((hash) => {
    location.hash = hash;
  }, `${long}/780`);
  await page.locator('.time[data-frame="780"]').waitFor();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('ControlOrMeta+Equal');
    await pause(150);
  }
  await page.keyboard.press('Space');
  await pressAt(page, 900, 's');
  await pressAt(page, 1100, 'd');
  await pressAt(page, 1250, 's');
  await pressAt(page, 1450, 'd');
  await page.keyboard.press('Space');
  await pause(2500);

  await caption(page, 'Saved as the contract asks: nanosecond strings, [start, stop)');
  await pause(1500);
  await page.goto(`${BASE}/api/annotations/${folding}`);
  await pause(4000);
  await context.close();
} finally {
  await browser?.close();
  await server.stop();
}

/** Shows a one-line caption at the top of the page (part of the demo, not of the tool). */
async function caption(page: Page, text: string): Promise<void> {
  await page.evaluate((line) => {
    let box = document.getElementById('demo-caption');
    if (!box) {
      box = document.createElement('div');
      box.id = 'demo-caption';
      box.style.cssText =
        'position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:9;padding:8px 16px;border-radius:8px;background:#5aa0ff;color:#04111f;font:600 16px system-ui';
      document.body.append(box);
    }
    box.textContent = line;
  }, text);
  await pause(1200);
}

/** Presses `key` once the video shows `frame` or later. */
async function pressAt(page: Page, frame: number, key: string): Promise<void> {
  await waitForFrame(page, frame);
  await page.keyboard.press(key);
}

function waitForFrame(page: Page, frame: number) {
  return page.waitForFunction(
    (target) => Number(document.querySelector('.time')?.getAttribute('data-frame')) >= target,
    frame,
    { timeout: 120_000 },
  );
}

function pause(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
