/** Accessibility basics: names for every control, labelled dialogs that take the focus. */
import { expect, test } from '@playwright/test';
import { SYNTHETIC_RECORDINGS, type SyntheticRecording } from './synthetic.ts';

const recording = SYNTHETIC_RECORDINGS[1] as SyntheticRecording;

test.beforeEach(async ({ page }) => {
  await page.goto(`/#${recording.id}/10`);
  await expect(page.locator('.time[data-frame="10"]')).toBeVisible();
});

test('every control, video and tab has a name; the tab title names the recording', async ({
  page,
}) => {
  await expect(page).toHaveTitle(new RegExp(recording.id));
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const unnamed = await page
    .locator('button, a, video:not([hidden]), [role="tab"]')
    .evaluateAll((elements) =>
      elements
        .filter(
          (e) =>
            !(e.getAttribute('aria-label') || e.textContent?.trim() || e.getAttribute('title')),
        )
        .map((e) => e.outerHTML.slice(0, 80)),
    );
  expect(unnamed).toEqual([]);
  await expect(page.getByRole('tablist').getByRole('tab', { selected: true })).toHaveText(
    'Intervals',
  );
});

test('the key list and the queue are labelled dialogs that take the focus', async ({ page }) => {
  for (const [open, name] of [
    [() => page.keyboard.press('h'), 'All keys'],
    [() => page.getByRole('button', { name: 'Queue' }).click(), 'Queue'],
  ] as const) {
    await open();
    const dialog = page.getByRole('dialog', { name });
    await expect(dialog).toBeFocused();
    // Tab stays inside: the rest of the screen is inert while a dialog is open.
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
});

test('a question about an outcome is an alert dialog with its keys on its buttons', async ({
  page,
}) => {
  await page.keyboard.press('n');
  const question = page.getByRole('alertdialog', { name: /No useful task/ });
  await expect(question.getByRole('button', { name: 'Confirm (↵)' })).toBeVisible();
  await expect(question.getByRole('button', { name: 'Back (Esc)' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(question).toBeHidden();
});
