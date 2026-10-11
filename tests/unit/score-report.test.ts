import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { AnnotationFile } from '../../src/core/annotation.ts';
import { frameNs, parseFramesCsv, stopNs } from '../../src/core/frame-map.ts';
import { referenceCamera } from '../../src/server/catalog.ts';
import { ingest } from '../../src/server/ingest.ts';
import { formatReport, scoreFolders } from '../../src/server/score-report.ts';
import { tempDir, writeRecording } from './fixtures.ts';

/** Two recordings; gold for both, an annotation for the first only. */
async function setUp() {
  const root = await tempDir();
  await writeRecording(join(root, 'data'), { id: 'rec-a', frames: 100 });
  await writeRecording(join(root, 'data'), { id: 'rec-b', frames: 100 });
  const { catalog } = await ingest({
    dataDir: join(root, 'data'),
    outDir: join(root, 'derived'),
    guidelinePath: null,
    tools: null,
  });
  const recording = catalog.recordings.find((r) => r.id === 'rec-a')!;
  const frames = parseFramesCsv(await readFile(referenceCamera(recording).framesPath, 'utf8'));
  const contract = (id: string, ranges: [number, number][]): AnnotationFile => ({
    recording_id: id,
    reference_video: 'videos/head-0000.mp4',
    status: 'complete',
    keep_intervals: ranges.map(([start, end]) => ({
      start_ns: String(frameNs(frames, start)),
      end_ns: String(stopNs(frames, end)),
    })),
    notes: '',
  });
  const gold = join(root, 'gold');
  const test = join(root, 'annotations');
  await mkdir(gold);
  await mkdir(test);
  const write = (dir: string, name: string, value: unknown) =>
    writeFile(join(dir, name), JSON.stringify(value));
  await write(
    gold,
    'rec-a.json',
    contract('rec-a', [
      [10, 30],
      [50, 70],
    ]),
  );
  await write(gold, 'rec-b.json', contract('rec-b', [[5, 9]]));
  // Starts 2 frames late and 1 early; the first stop exact, the second 3 frames early.
  await write(
    test,
    'rec-a.json',
    contract('rec-a', [
      [12, 30],
      [49, 67],
    ]),
  );
  await write(test, 'rec-a.meta.json', {
    effort: { active_ms: recording.durationS * 700, wall_ms: 0, edits: 4, undos: 1 },
  });
  const telemetry = join(root, 'events.jsonl');
  const accepted = (checkMs: number) =>
    JSON.stringify({ event: 'boundary_accepted', recording_id: 'rec-a', check_ms: checkMs });
  await writeFile(
    telemetry,
    [accepted(2000), accepted(4000), '{"event":"playback"}', ''].join('\n'),
  );
  return { catalog, gold, test, telemetry };
}

describe('score report', () => {
  test('compares every annotation that has gold, with its effort', async () => {
    const { catalog, gold, test: annotations, telemetry } = await setUp();
    const report = await scoreFolders(gold, annotations, catalog, telemetry);
    expect(report.skipped).toEqual(['rec-b']);
    const [a] = report.recordings;
    expect(a?.score).toMatchObject({
      goldIntervals: 2,
      testIntervals: 2,
      startErrors: [2, -1],
      endErrors: [0, -3],
      missed: 0,
      extra: 0,
    });
    expect(a?.realTimeFactor).toBeCloseTo(0.7);
    expect(a?.checkSeconds).toMatchObject({ count: 2, medianAbs: 2 });
    expect(report.starts.count).toBe(2);

    const table = formatReport(report);
    expect(table).toContain('rec-a');
    expect(table).toContain('No gold or no annotation to compare: rec-b');
  });

  test('works without telemetry', async () => {
    const { catalog, gold, test: annotations } = await setUp();
    const report = await scoreFolders(gold, annotations, catalog, null);
    expect(report.recordings[0]?.checkSeconds).toBeNull();
  });
});
