/**
 * Opt-in checks against the real recordings, which never enter the repo. Point RECORDINGS_DIR at
 * the folder holding the downloads:
 *
 *   RECORDINGS_DIR=~/Downloads/recordings pnpm test
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { keepIntervals } from '../../src/core/annotation.ts';
import { frameCount, parseFramesCsv } from '../../src/core/frame-map.ts';
import { emptyTimeline, setStateFrom } from '../../src/core/timeline.ts';
import { findMediaTools } from '../../src/server/ffmpeg.ts';
import { ingest } from '../../src/server/ingest.ts';
import { tempDir } from './fixtures.ts';

const root = process.env.RECORDINGS_DIR;

describe.runIf(root !== undefined && existsSync(root))('real recordings', () => {
  const ingested = (async () =>
    ingest({
      dataDir: root ?? '',
      outDir: join(await tempDir(), 'derived'),
      tasksDir: null,
      tools: await findMediaTools(),
    }))();

  test('all four pass ingest, in both folder layouts, with the template mix-ups flagged', async () => {
    const { catalog, inspections } = await ingested;
    expect(inspections.flatMap((i) => i.errors)).toEqual([]);
    expect(catalog.recordings.map((r) => r.id)).toEqual([
      '2026-10-09--09-40-56',
      '2026-10-09--09-48-47',
      '2026-10-09--10-04-08',
      '2026-10-06--10-11-23',
    ]);
    expect(catalog.recordings.map((r) => r.warnings.length > 0)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  }, 60_000);

  test('the worked example exports exactly', async () => {
    const { catalog } = await ingested;
    const head = catalog.recordings[0]?.cameras[0];
    const frames = parseFramesCsv(await readFile(head?.framesPath ?? '', 'utf8'));
    let t = emptyTimeline(frameCount(frames));
    t = setStateFrom(t, 60, 'keep', 'paused');
    t = setStateFrom(t, 2310, 'cut', 'paused');
    expect(keepIntervals(t, frames)).toEqual([
      { start_ns: '3018566655052', end_ns: '3093598123682' },
    ]);
  }, 60_000);
});
