/**
 * A scoring report: every completed annotation that has a gold counterpart, compared boundary by
 * boundary, with the effort it took. The numbers come from src/core/score.ts; this module only
 * finds the files and adds them up.
 *
 * Speed is the real-time factor (active time ÷ video length, from each sidecar) and the seconds
 * spent per checked boundary (from the telemetry of the annotator who saved the file). Accuracy is
 * boundary error in frames and interval mistakes. They are reported side by side, never blended:
 * accuracy is a floor, speed is what to improve above it. Drafts and recordings sent to review
 * are not scored: only accepted work counts. Gold and annotation files are checked against the
 * contract like a save, and a recording with a file that breaks it is not scored either.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AnnotationFile,
  type Reference,
  type Sidecar,
  validateAnnotationFile,
} from '../core/annotation.ts';
import { type FrameMap, parseFramesCsv } from '../core/frame-map.ts';
import {
  type ErrorSummary,
  frameRanges,
  type Score,
  scoreRanges,
  summarizeErrors,
} from '../core/score.ts';
import { type Catalog, referenceCamera } from './catalog.ts';

export interface DurationSummary {
  readonly count: number;
  /** Nearest-rank percentiles, in seconds. */
  readonly median: number;
  readonly p90: number;
}

export interface RecordingScore {
  readonly id: string;
  readonly score: Score;
  readonly starts: ErrorSummary;
  readonly ends: ErrorSummary;
  readonly durationS: number;
  /** Active time in seconds, from the sidecar; null without one. */
  readonly activeS: number | null;
  readonly checkSeconds: DurationSummary | null;
}

export interface Report {
  readonly recordings: readonly RecordingScore[];
  readonly starts: ErrorSummary;
  readonly ends: ErrorSummary;
  /** Active time ÷ video length over every scored recording with effort; null if none. */
  readonly realTimeFactor: number | null;
  readonly checkSeconds: DurationSummary | null;
  /** Recordings left out, and why. */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  /** Files that break the contract; their recordings are not scored. */
  readonly invalid: readonly { readonly path: string; readonly problems: readonly string[] }[];
  /** Telemetry lines that couldn't be read. */
  readonly badTelemetryLines: number;
}

export async function scoreFolders(
  goldDir: string,
  testDir: string,
  catalog: Catalog,
  telemetryPath: string | null,
): Promise<Report> {
  const telemetry = telemetryPath ? await readChecks(telemetryPath) : { checks: [], bad: 0 };
  const recordings: RecordingScore[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const invalid: { path: string; problems: readonly string[] }[] = [];
  const allChecks: number[] = [];
  for (const recording of catalog.recordings) {
    const camera = referenceCamera(recording);
    // The frames are read only for a recording that has a file to check.
    let framesRead: Promise<FrameMap> | undefined;
    const reference = async (): Promise<Reference> => {
      framesRead ??= readFile(camera.framesPath, 'utf8').then(parseFramesCsv);
      return { recordingId: recording.id, referenceVideo: camera.video, frames: await framesRead };
    };
    const goldFile = await readContract(join(goldDir, `${recording.id}.json`), reference);
    const testFile = await readContract(join(testDir, `${recording.id}.json`), reference);
    const broken = [goldFile, testFile].filter((file) => file.problems.length > 0);
    if (broken.length > 0) {
      invalid.push(...broken.map(({ path, problems }) => ({ path, problems })));
      continue;
    }
    const gold = goldFile.annotation;
    const test = testFile.annotation;
    if (!gold || !test) {
      skipped.push({ id: recording.id, reason: gold ? 'no annotation' : 'no gold' });
      continue;
    }
    if (test.status !== 'complete') {
      skipped.push({ id: recording.id, reason: test.status.replace('_', ' ') });
      continue;
    }
    const { frames } = await reference();
    const score = scoreRanges(
      frameRanges(gold.keep_intervals, frames),
      frameRanges(test.keep_intervals, frames),
      frames,
    );
    const sidecar = await readJson<Sidecar>(join(testDir, `${recording.id}.meta.json`));
    // Only the checks of whoever saved this annotation.
    const checks = telemetry.checks
      .filter((c) => c.recordingId === recording.id && c.annotatorId === sidecar?.annotator_id)
      .map((c) => c.seconds);
    allChecks.push(...checks);
    recordings.push({
      id: recording.id,
      score,
      starts: summarizeErrors(score.startErrors),
      ends: summarizeErrors(score.endErrors),
      durationS: recording.durationS,
      activeS: sidecar ? sidecar.effort.active_ms / 1000 : null,
      checkSeconds: summarizeDurations(checks),
    });
  }
  const timed = recordings.filter((r) => r.activeS !== null);
  const activeS = timed.reduce((total, r) => total + (r.activeS ?? 0), 0);
  const durationS = timed.reduce((total, r) => total + r.durationS, 0);
  return {
    recordings,
    starts: summarizeErrors(recordings.flatMap((r) => r.score.startErrors)),
    ends: summarizeErrors(recordings.flatMap((r) => r.score.endErrors)),
    realTimeFactor: durationS > 0 ? activeS / durationS : null,
    checkSeconds: summarizeDurations(allChecks),
    skipped,
    invalid,
    badTelemetryLines: telemetry.bad,
  };
}

interface ContractFile {
  readonly path: string;
  /** Null when the file is missing or breaks the contract. */
  readonly annotation: AnnotationFile | null;
  readonly problems: readonly string[];
}

/** A gold or annotation file, checked against the contract like a save. */
async function readContract(
  path: string,
  reference: () => Promise<Reference>,
): Promise<ContractFile> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, annotation: null, problems: [] };
    }
    if (!(error instanceof SyntaxError)) throw error;
    return { path, annotation: null, problems: [`not valid JSON (${error.message})`] };
  }
  const problems = validateAnnotationFile(value, await reference());
  return { path, annotation: problems.length > 0 ? null : (value as AnnotationFile), problems };
}

interface Check {
  readonly recordingId: string;
  readonly annotatorId: string;
  readonly seconds: number;
}

/** Each accepted rough mark's check time, from telemetry; lines that don't parse are counted. */
async function readChecks(path: string): Promise<{ checks: Check[]; bad: number }> {
  const text = await readFile(path, 'utf8').catch(() => '');
  const checks: Check[] = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event: {
      event?: unknown;
      recording_id?: unknown;
      annotator_id?: unknown;
      check_ms?: unknown;
    };
    try {
      event = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    const { recording_id, annotator_id, check_ms } = event;
    if (
      event.event === 'boundary_accepted' &&
      typeof recording_id === 'string' &&
      typeof annotator_id === 'string' &&
      typeof check_ms === 'number'
    ) {
      checks.push({
        recordingId: recording_id,
        annotatorId: annotator_id,
        seconds: check_ms / 1000,
      });
    }
  }
  return { checks, bad };
}

function summarizeDurations(seconds: readonly number[]): DurationSummary | null {
  if (seconds.length === 0) return null;
  // Durations are never negative, so the percentiles of their absolute values are theirs.
  const { count, medianAbs, p90Abs } = summarizeErrors(seconds);
  return { count, median: medianAbs, p90: p90Abs };
}

/** The report as a table for the terminal. */
export function formatReport(report: Report): string {
  const errors = (s: ErrorSummary) =>
    s.count === 0 ? '–' : `${s.medianAbs} / ${s.p90Abs} (${signed(s.meanSigned)})`;
  const checks = (s: DurationSummary | null) =>
    s ? `${s.median.toFixed(1)} / ${s.p90.toFixed(1)} (${s.count})` : '–';
  const factor = (value: number | null) => (value === null ? '–' : value.toFixed(2));
  const rows = report.recordings.map((r) => [
    r.id,
    `${r.score.goldIntervals} / ${r.score.testIntervals}`,
    errors(r.starts),
    errors(r.ends),
    `${r.score.missed} / ${r.score.extra} / ${r.score.merged} / ${r.score.split}`,
    `${r.score.falseKeepSeconds.toFixed(1)} / ${r.score.falseCutSeconds.toFixed(1)}`,
    factor(r.activeS === null ? null : r.activeS / r.durationS),
    checks(r.checkSeconds),
  ]);
  const header = [
    'recording',
    'intervals gold / test',
    'start error, frames: median / p90 (bias)',
    'stop error, frames: median / p90 (bias)',
    'missed / extra / merged / split',
    'kept / cut wrongly, s',
    'real-time factor',
    's per check: median / p90 (n)',
  ];
  const total = [
    'all',
    '',
    errors(report.starts),
    errors(report.ends),
    '',
    '',
    factor(report.realTimeFactor),
    checks(report.checkSeconds),
  ];
  const table = [header, ...rows, total];
  const widths = header.map((_, column) =>
    Math.max(...table.map((row) => (row[column] ?? '').length)),
  );
  const lines = table.map((row) =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  '),
  );
  const notes = [
    ...report.invalid.map(
      ({ path, problems }) => `Not scored: ${path} is invalid: ${problems.join('; ')}`,
    ),
    ...report.skipped.map(({ id, reason }) => `Not scored: ${id} (${reason})`),
    ...(report.badTelemetryLines > 0
      ? [`Telemetry lines that couldn't be read: ${report.badTelemetryLines}`]
      : []),
  ];
  return `${[...lines, ...(notes.length > 0 ? ['', ...notes] : [])].join('\n')}\n`;
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
