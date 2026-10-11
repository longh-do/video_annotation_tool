import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { TaskGuide } from '../../src/server/catalog.ts';
import { guideMarkdown, readTaskGuides, tasksCovering } from '../../src/server/task-guides.ts';
import { tempDir } from './fixtures.ts';

/** Writes the files into a new folder and reads the guides in it. */
async function read(files: Record<string, string>) {
  const dir = await tempDir();
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return { dir, ...(await readTaskGuides(dir)) };
}

describe('task guides', () => {
  test('reads the patterns, the first heading as title, and a hash of the whole file', async () => {
    const text =
      '---\nrecordings: kitchen-*, lab-2-*  lab-3,lab-4\n---\n\n# Stack the cups\n\nKeep…\n';
    const { dir, tasks, warnings } = await read({ 'stack-cups.md': text });
    expect(warnings).toEqual([]);
    expect(tasks.get('stack-cups')).toEqual({
      path: join(dir, 'stack-cups.md'),
      title: 'Stack the cups',
      version: `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`,
      recordings: ['kitchen-*', 'lab-2-*', 'lab-3', 'lab-4'],
    });
  });

  test('takes the file name as title when the guide has no heading', async () => {
    const { tasks } = await read({ 'plain.md': '---\nrecordings: a\n---\nJust text.\n' });
    expect(tasks.get('plain')?.title).toBe('plain.md');
  });

  test('skips a file without a header, or whose header names no recordings', async () => {
    const { tasks, warnings } = await read({
      'empty.md': '---\nrecordings:\n---\n# Empty\n',
      'no-header.md': '# Just a guide\n\n---\n',
      'unclosed.md': '---\nrecordings: a\n# Never closed\n',
    });
    expect(tasks.size).toBe(0);
    expect(warnings).toEqual([
      'empty.md: its header names no recordings; skipped it',
      'no-header.md: no header naming its recordings; skipped it',
      'unclosed.md: no header naming its recordings; skipped it',
    ]);
  });

  test('warns about an unknown header key and keeps the guide', async () => {
    const { tasks, warnings } = await read({
      'cups.md': '---\nowner: lead\nrecordings: cups-*\n---\n# Cups\n',
    });
    expect(tasks.get('cups')?.recordings).toEqual(['cups-*']);
    expect(warnings).toEqual(['cups.md: unknown header key "owner"; ignored it']);
  });

  test('reads only .md files directly in the folder, in name order, whose names are plain', async () => {
    const guide = '---\nrecordings: *\n---\n';
    const dir = await tempDir();
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'nested', 'deeper.md'), guide);
    const files = { 'b.md': guide, 'a.md': guide, 'notes.txt': guide, 'two words.md': guide };
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    const { tasks, warnings } = await readTaskGuides(dir);
    expect([...tasks.keys()]).toEqual(['a', 'b']);
    expect(warnings).toEqual(['two words.md: not a plain name; skipped it']);
  });

  test('matches * against any run of characters and everything else literally', () => {
    const guide = (recordings: string[]): TaskGuide => ({
      path: '',
      title: '',
      version: '',
      recordings,
    });
    const tasks = new Map([
      ['cups', guide(['cups-*'])],
      ['ones', guide(['*-1', 'x.y'])],
    ]);
    expect(tasksCovering('cups-1', tasks)).toEqual(['cups', 'ones']);
    expect(tasksCovering('cups-', tasks)).toEqual(['cups']);
    expect(tasksCovering('teacups-2', tasks)).toEqual([]);
    expect(tasksCovering('x.y', tasks)).toEqual(['ones']);
    expect(tasksCovering('xzy', tasks)).toEqual([]);
  });

  test('gives annotators the Markdown without the header', () => {
    const text = '---\r\nrecordings: a\r\n---\r\n\r\n\r\n# Cups\r\n\r\nKeep it.\r\n';
    expect(guideMarkdown(text)).toBe('# Cups\n\nKeep it.\n');
    expect(guideMarkdown('# No header\n')).toBe('# No header\n');
  });
});
