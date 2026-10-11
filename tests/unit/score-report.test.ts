import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import type { AnnotationFile, Status } from '../../src/core/annotation.ts';
import { frameNs, parseFramesCsv, stopNs } from '../../src/core/frame-map.ts';
import { referenceCamera } from '../../src/server/catalog.ts';
import { ingest } from '../../src/server/ingest.ts';
import { formatReport, scoreFolders } from '../../src/server/score-report.ts';
import { tempDir, writeRecording } from './fixtures.ts';

/** Three recordings with gold: one done by annotator a1, one still a draft, one never opened. */
async function setUp() {
  const root = await tempDir();
  for (const id of ['rec-a', 'rec-b', 'rec-c']) {
    await writeRecording(join(root, 'data'), { id, frames: 100 });
  }
  const { catalog } = await ingest({
    dataDir: join(root, 'data'),
    outDir: join(root, 'derived'),
    tasksDir: null,
    tools: null,
  });
  const recording = catalog.recordings.find((r) => r.id === 'rec-a')!;
  const frames = parseFramesCsv(await readFile(referenceCamera(recording).framesPath, 'utf8'));
  const contract = (id: string, ranges: [number, number][], status: Status = 'complete') =>
    ({
      recording_id: id,
      reference_video: 'videos/head-0000.mp4',
      status,
      keep_intervals: ranges.map(([start, end]) => ({
        start_ns: String(frameNs(frames, start)),
        end_ns: String(stopNs(frames, end)),
      })),
      notes: '',
    }) satisfies AnnotationFile;
  const gold = join(root, 'gold');
  const test = join(root, 'annotations');
  await mkdir(gold);
  await mkdir(test);
  const write = (dir: string, name: string, value: unknown) =>
    writeFile(join(dir, name), JSON.stringify(value));
  for (const id of ['rec-a', 'rec-b', 'rec-c']) {
    await write(
      gold,
      `${id}.json`,
      contract(id, [
        [10, 30],
        [50, 70],
      ]),
    );
  }
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
    annotator_id: 'a1',
    effort: { active_ms: recording.durationS * 700, wall_ms: 0, edits: 4, undos: 1 },
  });
  await write(test, 'rec-b.json', contract('rec-b', [[10, 20]], 'not_reviewed'));
  const telemetry = join(root, 'events.jsonl');
  const accepted = (annotator: string, checkMs: number) =>
    JSON.stringify({
      event: 'boundary_accepted',
      recording_id: 'rec-a',
      annotator_id: annotator,
      check_ms: checkMs,
    });
  const lines = [accepted('a1', 2000), accepted('a1', 4000), accepted('lead', 9000)];
  await writeFile(telemetry, [...lines, '{"event":"playback"}', '{"event":"bound', ''].join('\n'));
  const catalogPath = join(root, 'derived', 'catalog.json');
  return { catalog, catalogPath, gold, test, telemetry, contract };
}

/** Runs `pnpm score`; resolves with its exit code and what it printed. */
function score(...args: string[]) {
  const script = join(import.meta.dirname, '..', '..', 'scripts', 'score.ts');
  return promisify(execFile)(process.execPath, [script, ...args]).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }),
  );
}

describe('score report', () => {
  test('scores completed annotations with gold, with the effort of whoever saved them', async () => {
    const { catalog, gold, test: annotations, telemetry } = await setUp();
    const report = await scoreFolders(gold, annotations, catalog, telemetry);
    expect(report.skipped).toEqual([
      { id: 'rec-b', reason: 'not reviewed' },
      { id: 'rec-c', reason: 'no annotation' },
    ]);
    expect(report.invalid).toEqual([]);
    const [a] = report.recordings;
    expect(a?.score).toMatchObject({
      goldIntervals: 2,
      testIntervals: 2,
      startErrors: [2, -1],
      endErrors: [0, -3],
      missed: 0,
      extra: 0,
    });
    expect(report.realTimeFactor).toBeCloseTo(0.7);
    // The lead's 9 s check of the same recording is not this annotator's.
    expect(a?.checkSeconds).toEqual({ count: 2, median: 2, p90: 4 });
    expect(report.checkSeconds).toEqual({ count: 2, median: 2, p90: 4 });
    expect(report.badTelemetryLines).toBe(1);

    const table = formatReport(report);
    expect(table).toContain('2.0 / 4.0 (2)');
    expect(table).toContain('Not scored: rec-b (not reviewed)');
    expect(table).toContain("Telemetry lines that couldn't be read: 1");
  });

  test('works without telemetry', async () => {
    const { catalog, gold, test: annotations } = await setUp();
    const report = await scoreFolders(gold, annotations, catalog, null);
    expect(report.recordings[0]?.checkSeconds).toBeNull();
  });

  test('names every file that breaks the contract and scores nothing against it', async () => {
    const { catalog, gold, test: annotations, contract } = await setUp();
    // Gold of another recording, gold out of order, a stop that is no timestamp, and no JSON.
    await writeFile(join(gold, 'rec-a.json'), JSON.stringify(contract('rec-c', [[10, 30]])));
    const unsorted = contract('rec-c', [
      [50, 70],
      [10, 30],
    ]);
    await writeFile(join(gold, 'rec-c.json'), JSON.stringify(unsorted));
    const noTime = {
      ...contract('rec-b', []),
      keep_intervals: [{ start_ns: '0', end_ns: 'soon' }],
    };
    await writeFile(join(annotations, 'rec-b.json'), JSON.stringify(noTime));
    await writeFile(join(annotations, 'rec-c.json'), '{ "recording_id": ');

    const report = await scoreFolders(gold, annotations, catalog, null);
    expect(report.recordings).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.invalid).toEqual([
      { path: join(gold, 'rec-a.json'), problems: ['recording_id must be "rec-a"'] },
      {
        path: join(annotations, 'rec-b.json'),
        problems: [
          'keep_intervals[0] must be {"start_ns", "end_ns"} with decimal-string timestamps',
        ],
      },
      {
        path: join(gold, 'rec-c.json'),
        problems: ['keep_intervals[1] must start after the previous interval ends'],
      },
      {
        path: join(annotations, 'rec-c.json'),
        problems: [expect.stringMatching(/^not valid JSON/)],
      },
    ]);
    expect(formatReport(report)).toContain(
      `Not scored: ${join(gold, 'rec-a.json')} is invalid: recording_id must be "rec-a"`,
    );
  });

  test('pnpm score exits non-zero on an invalid file or a missing folder', async () => {
    const { catalogPath, gold, test: annotations, telemetry } = await setUp();
    const options = ['--catalog', catalogPath, '--telemetry', telemetry];
    expect((await score(gold, annotations, ...options)).code).toBe(0);
    await writeFile(join(gold, 'rec-a.json'), '[]');
    const failed = await score(gold, annotations, ...options);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain(`Not scored: ${join(gold, 'rec-a.json')} is invalid`);
    expect((await score(join(gold, 'missing'), annotations, ...options)).code).toBe(2);
  });
});
