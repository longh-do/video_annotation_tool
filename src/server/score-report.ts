/**
 * A scoring report: every annotation that has a gold counterpart, compared boundary by boundary,
 * with the effort it took. The numbers come from src/core/score.ts; this module only finds the
 * files and adds them up.
 *
 * Speed is the real-time factor (active time ÷ video length, from each sidecar) and the seconds
 * spent per checked boundary (from telemetry). Accuracy is boundary error in frames and interval
 * mistakes. They are reported side by side, never blended: accuracy is a floor, speed is what to
 * improve above it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnnotationFile, Sidecar } from '../core/annotation.ts';
import { parseFramesCsv } from '../core/frame-map.ts';
import {
  type ErrorSummary,
  frameRanges,
  type Score,
  scoreRanges,
  summarizeErrors,
} from '../core/score.ts';
import { type Catalog, referenceCamera } from './catalog.ts';

export interface RecordingScore {
  readonly id: string;
  readonly score: Score;
  readonly starts: ErrorSummary;
  readonly ends: ErrorSummary;
  /** Active time ÷ video length; null without a sidecar. */
  readonly realTimeFactor: number | null;
  readonly checkSeconds: ErrorSummary | null;
}

export interface Report {
  readonly recordings: readonly RecordingScore[];
  readonly starts: ErrorSummary;
  readonly ends: ErrorSummary;
  /** Recordings in the catalog with no gold or no annotation to compare. */
  readonly skipped: readonly string[];
}

export async function scoreFolders(
  goldDir: string,
  testDir: string,
  catalog: Catalog,
  telemetryPath: string | null,
): Promise<Report> {
  const checks = telemetryPath ? await checkDurations(telemetryPath) : new Map<string, number[]>();
  const recordings: RecordingScore[] = [];
  const skipped: string[] = [];
  for (const recording of catalog.recordings) {
    const gold = await readJson<AnnotationFile>(join(goldDir, `${recording.id}.json`));
    const test = await readJson<AnnotationFile>(join(testDir, `${recording.id}.json`));
    if (!gold || !test) {
      skipped.push(recording.id);
      continue;
    }
    const frames = parseFramesCsv(await readFile(referenceCamera(recording).framesPath, 'utf8'));
    const score = scoreRanges(
      frameRanges(gold.keep_intervals, frames),
      frameRanges(test.keep_intervals, frames),
      frames,
    );
    const sidecar = await readJson<Sidecar>(join(testDir, `${recording.id}.meta.json`));
    const durations = checks.get(recording.id);
    recordings.push({
      id: recording.id,
      score,
      starts: summarizeErrors(score.startErrors),
      ends: summarizeErrors(score.endErrors),
      realTimeFactor: sidecar ? sidecar.effort.active_ms / 1000 / recording.durationS : null,
      checkSeconds: durations ? summarizeErrors(durations) : null,
    });
  }
  return {
    recordings,
    starts: summarizeErrors(recordings.flatMap((r) => r.score.startErrors)),
    ends: summarizeErrors(recordings.flatMap((r) => r.score.endErrors)),
    skipped,
  };
}

/** Seconds from landing on a rough mark to accepting it, per recording, from telemetry. */
async function checkDurations(path: string): Promise<Map<string, number[]>> {
  const durations = new Map<string, number[]>();
  const text = await readFile(path, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as { event?: string; recording_id?: string; check_ms?: number };
    if (
      event.event !== 'boundary_accepted' ||
      typeof event.check_ms !== 'number' ||
      !event.recording_id
    )
      continue;
    durations.set(event.recording_id, [
      ...(durations.get(event.recording_id) ?? []),
      event.check_ms / 1000,
    ]);
  }
  return durations;
}

/** The report as a table for the terminal. */
export function formatReport(report: Report): string {
  const errors = (s: ErrorSummary) =>
    s.count === 0 ? '–' : `${s.medianAbs} / ${s.p90Abs} (${signed(s.meanSigned)})`;
  const rows = report.recordings.map((r) => [
    r.id,
    `${r.score.goldIntervals} / ${r.score.testIntervals}`,
    errors(r.starts),
    errors(r.ends),
    `${r.score.missed} / ${r.score.extra} / ${r.score.merged} / ${r.score.split}`,
    `${r.score.falseKeepSeconds.toFixed(1)} / ${r.score.falseCutSeconds.toFixed(1)}`,
    r.realTimeFactor === null ? '–' : r.realTimeFactor.toFixed(2),
    r.checkSeconds ? r.checkSeconds.medianAbs.toFixed(1) : '–',
  ]);
  const header = [
    'recording',
    'intervals gold / test',
    'start error, frames: median / p90 (bias)',
    'stop error, frames: median / p90 (bias)',
    'missed / extra / merged / split',
    'kept / cut wrongly, s',
    'real-time factor',
    's per check',
  ];
  const total = ['all', '', errors(report.starts), errors(report.ends), '', '', '', ''];
  const table = [header, ...rows, total];
  const widths = header.map((_, column) =>
    Math.max(...table.map((row) => (row[column] ?? '').length)),
  );
  const lines = table.map((row) =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  '),
  );
  const skipped =
    report.skipped.length > 0
      ? `\nNo gold or no annotation to compare: ${report.skipped.join(', ')}`
      : '';
  return `${lines.join('\n')}${skipped}\n`;
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
