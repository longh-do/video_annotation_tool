import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { SaveChip } from '../../../src/web/components/SaveChip.tsx';
import type { SaveStatus } from '../../../src/web/saver.ts';

const text = (status: SaveStatus) =>
  renderToStaticMarkup(createElement(SaveChip, { status })).replace(/<[^>]*>/g, '');

test('a failing save says whether the server answered, and whether the change is kept', () => {
  expect(text({ kind: 'offline', serverError: null, kept: true })).toBe(
    'Offline — kept on this computer, retrying',
  );
  expect(text({ kind: 'offline', serverError: 'HTTP 500', kept: false })).toBe(
    'Server error — not kept on this computer, retrying',
  );
  expect(text({ kind: 'saved' })).toBe('✓ Saved');
});
