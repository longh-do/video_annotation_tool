/**
 * ffprobe/ffmpeg, used only at ingest and only when installed: they double-check the frames CSVs
 * against the videos and render keyframe thumbnails. Without them ingest still validates
 * everything else.
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BIG_OUTPUT = { maxBuffer: 256 * 1024 * 1024 };

export interface VideoProbe {
  readonly timeBase: string;
  /** Packet timestamps in time-base units, sorted into presentation order. */
  readonly pts: readonly number[];
}

export interface Sprites {
  readonly sheetPaths: readonly string[];
  /** Presentation timestamp of each thumbnail, in time-base units, in sheet order. */
  readonly pts: readonly number[];
}

export interface MediaTools {
  probe(videoPath: string): Promise<VideoProbe>;
  /** Keyframes only, scaled to `tileWidth`, packed 20 × 20 per sheet: fast even for 42 minutes. */
  sprites(videoPath: string, outDir: string, tileWidth: number): Promise<Sprites>;
}

export const SPRITE_GRID = 20;

/** The name of every sprite sheet `sprites` writes. */
export const SHEET_NAME = /^thumbs-\d+\.jpg$/;

export async function findMediaTools(): Promise<MediaTools | null> {
  try {
    await Promise.all([run('ffprobe', ['-version']), run('ffmpeg', ['-version'])]);
  } catch {
    return null;
  }
  return { probe, sprites };
}

async function probe(videoPath: string): Promise<VideoProbe> {
  const stream = await run('ffprobe', [
    ...['-v', 'error', '-select_streams', 'v:0'],
    ...['-show_entries', 'stream=time_base', '-of', 'csv=p=0', videoPath],
  ]);
  const packets = await run(
    'ffprobe',
    [
      ...['-v', 'error', '-select_streams', 'v:0'],
      ...['-show_entries', 'packet=pts', '-of', 'csv=p=0', videoPath],
    ],
    BIG_OUTPUT,
  );
  return {
    timeBase: stream.stdout.trim(),
    pts: integers(packets.stdout).sort((a, b) => a - b),
  };
}

async function sprites(videoPath: string, outDir: string, tileWidth: number): Promise<Sprites> {
  const grid = `${SPRITE_GRID}x${SPRITE_GRID}`;
  await run('ffmpeg', [
    ...['-v', 'error', '-y', '-skip_frame', 'nokey', '-i', videoPath],
    ...['-vf', `scale=${tileWidth}:-2,tile=${grid}`, '-fps_mode', 'passthrough', '-q:v', '5'],
    join(outDir, 'thumbs-%02d.jpg'),
  ]);
  const frames = await run(
    'ffprobe',
    [
      ...['-v', 'error', '-skip_frame', 'nokey', '-select_streams', 'v:0'],
      ...['-show_entries', 'frame=pts', '-of', 'csv=p=0', videoPath],
    ],
    BIG_OUTPUT,
  );
  const sheets = (await readdir(outDir)).filter((name) => SHEET_NAME.test(name)).sort();
  return { sheetPaths: sheets.map((name) => join(outDir, name)), pts: integers(frames.stdout) };
}

function integers(csv: string): number[] {
  return csv
    .split('\n')
    .map((line) => line.split(',')[0]?.trim() ?? '')
    .filter((cell) => cell !== '')
    .map((cell) => {
      const value = Number(cell);
      if (!Number.isSafeInteger(value))
        throw new Error(`ffprobe printed a non-integer timestamp: ${cell}`);
      return value;
    });
}
