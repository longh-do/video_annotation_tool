/**
 * Synthetic recordings for the end-to-end tests: the real folder layouts and file formats, with
 * real H.264 clips and no real data.
 *
 * Every frame shows its own index as a barcode (barcode.ts), so a test can tell exactly which
 * frame the browser displays. Frame gaps vary from 4.7 to 101 ms like the real videos, and each
 * camera has its own frame count and timing, so frame index and time never line up by accident.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  BARCODE_HEIGHT,
  BARCODE_PIXELS,
  BARCODE_WIDTH,
  barcodeFilter,
  decodeBarcode,
} from './barcode.ts';

const run = promisify(execFile);

/** Bump after changing what gets generated (here or in barcode.ts), so stale copies are rebuilt. */
const VERSION = '3';

/** Generated data and server state for the end-to-end tests (gitignored). */
export const E2E_DIR = resolve(import.meta.dirname, '../../.e2e');

export interface SyntheticRecording {
  readonly id: string;
  /** Its folder in the data folder, numbered like the real downloads. */
  readonly folder: string;
  /**
   * `together`: manifest, frames CSVs and videos/ in one folder. `split`: manifest and CSVs in
   * annotation-data/, beside videos/, like the long real recording.
   */
  readonly layout: 'together' | 'split';
  /** Frames of the head camera, the reference; the left and right cameras have one and two more. */
  readonly headFrames: number;
}

/**
 * In queue order (ingest orders recordings by folder). Annotations persist across the tests of a
 * run, so each spec that edits works on a recording of its own.
 */
export const SYNTHETIC_RECORDINGS: readonly SyntheticRecording[] = [
  { id: 'synthetic-a', folder: '01-synthetic-a', layout: 'together', headFrames: 600 },
  { id: 'synthetic-b', folder: '02-synthetic-b', layout: 'split', headFrames: 240 },
  { id: 'synthetic-c', folder: '03-synthetic-c', layout: 'together', headFrames: 300 },
  { id: 'synthetic-d', folder: '04-synthetic-d', layout: 'together', headFrames: 150 },
  { id: 'synthetic-e', folder: '05-synthetic-e', layout: 'together', headFrames: 120 },
];

const CAMERAS = [
  { name: 'umi.head.camera.enc', label: 'head', startOffsetNs: 0n },
  { name: 'umi.left.camera.enc', label: 'left', startOffsetNs: -24_000_000n },
  { name: 'umi.right.camera.enc', label: 'right', startOffsetNs: -27_500_000n },
] as const;

const WIDTH = 640;
const HEIGHT = 480;

/** Writes the recordings into `dataDir`, unless this version of them is already there. */
export async function writeSyntheticRecordings(dataDir: string): Promise<void> {
  const stamp = join(dataDir, '.generated');
  if ((await readFile(stamp, 'utf8').catch(() => null)) === VERSION) return;
  // Seeds 1, 2, …: each recording gets its own frame timing and source clock.
  await Promise.all(SYNTHETIC_RECORDINGS.map((r, i) => writeRecording(dataDir, r, i + 1)));
  await writeFile(stamp, VERSION);
}

async function writeRecording(
  dataDir: string,
  recording: SyntheticRecording,
  seed: number,
): Promise<void> {
  const folder = join(dataDir, recording.folder);
  const metaDir = recording.layout === 'split' ? join(folder, 'annotation-data') : folder;
  await rm(folder, { recursive: true, force: true });
  await mkdir(join(folder, 'videos'), { recursive: true });
  await mkdir(metaDir, { recursive: true });

  const headStartNs = 3_000_000_000_000n + BigInt(seed - 1) * 1_000_000_000_000n;
  const clips = await Promise.all(
    CAMERAS.map(async (camera, i) => {
      const video = `${camera.label}-0000.mp4`;
      // One frame more per camera, and a timing of its own.
      const frames = recording.headFrames + i;
      const ptsUs = await encodeClip(join(folder, 'videos', video), frames, seed + 10 * i);
      // Source time follows the video clock, plus a sub-µs remainder like real exports.
      const startNs = headStartNs + camera.startOffsetNs;
      const tsNs = ptsUs.map((us, k) => startNs + BigInt(us) * 1000n + BigInt((k * 7919) % 1000));
      await writeFile(join(metaDir, `${camera.label}-frames.csv`), framesCsv(video, ptsUs, tsNs));
      const part = {
        file: `videos/${video}`,
        frames,
        width: WIDTH,
        height: HEIGHT,
        source_start_ns: String(tsNs[0]),
        source_last_frame_ns: String(tsNs.at(-1)),
      };
      return { camera: camera.name, part, lastPtsUs: ptsUs.at(-1)! };
    }),
  );

  const head = clips[0]!;
  const manifest = {
    recording_id: recording.id,
    recording_duration_s: head.lastPtsUs / 1e6 + 0.5,
    default_camera: head.camera,
    cameras: Object.fromEntries(clips.map(({ camera, part }) => [camera, [part]])),
  };
  await writeFile(join(metaDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Encodes a clip like the real recordings (H.264 High, no B-frames, a keyframe every 60 frames,
 * timestamps in whole µs from 0) and returns its frame timestamps in µs, once checked.
 */
async function encodeClip(path: string, frames: number, seed: number): Promise<number[]> {
  const graph = [
    `testsrc2=size=${WIDTH}x${HEIGHT}:rate=30,format=yuv420p,split[picture][band]`,
    `[band]crop=${BARCODE_WIDTH}:${BARCODE_HEIGHT}:0:0,${barcodeFilter()}[barcode]`,
    `[picture][barcode]overlay,settb=1/1000000,setpts='${variableTimestamps(seed)}'`,
  ].join(';');
  await run('ffmpeg', [
    ...['-v', 'error', '-y', '-filter_complex', graph, '-frames:v', String(frames)],
    ...['-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '16'],
    ...['-bf', '0', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0'],
    ...['-fps_mode', 'passthrough', '-enc_time_base:v', '1/1000000'],
    ...['-video_track_timescale', '1000000', '-movflags', '+faststart', path],
  ]);
  const ptsUs = await packetPts(path);
  await checkBarcodes(path, frames);
  return ptsUs;
}

/**
 * A setpts expression for variable frame timing. The gap before frame N is 4.7–14.5 ms for 4% of
 * frames, 60–101 ms for another 4% and 25–41.5 ms otherwise; `seed` shifts the pattern.
 */
function variableTimestamps(seed: number): string {
  const hash = `mod(N*7919+${seed}*104729,1000)`;
  const short = `4700+${hash}*250`;
  const long = `60000+(${hash}-960)*1050`;
  const usual = `25000+(${hash}-40)*18`;
  const gapUs = `if(lt(${hash},40),${short},if(gte(${hash},960),${long},${usual}))`;
  return `if(eq(N,0),0,PREV_OUTPTS+${gapUs})`;
}

/** The clip's packet timestamps in µs. File order must be presentation order: no B-frames. */
async function packetPts(clip: string): Promise<number[]> {
  const { stdout } = await run('ffprobe', [
    ...['-v', 'error', '-select_streams', 'v:0'],
    ...['-show_entries', 'packet=pts', '-of', 'csv=p=0', clip],
  ]);
  const pts = stdout.trim().split('\n').map(Number);
  const k = pts.findIndex((us, i) => i > 0 && us <= pts[i - 1]!);
  if (k >= 0) throw new Error(`${clip}: packet ${k} is out of presentation order (B-frames?)`);
  return pts;
}

/** Decodes the clip's barcode band with ffmpeg and checks that every frame shows its index. */
async function checkBarcodes(clip: string, frames: number): Promise<void> {
  const { stdout: band } = await run(
    'ffmpeg',
    [
      ...['-v', 'error', '-i', clip, '-fps_mode', 'passthrough', '-f', 'rawvideo'],
      ...['-vf', `crop=${BARCODE_WIDTH}:${BARCODE_HEIGHT}:0:0,format=gray`, '-'],
    ],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
  );
  const size = BARCODE_WIDTH * BARCODE_HEIGHT;
  if (band.length !== frames * size) {
    throw new Error(`${clip}: decoded ${band.length / size} frames, expected ${frames}`);
  }
  for (let k = 0; k < frames; k++) {
    const luma = BARCODE_PIXELS.map(([x, y]) => band[k * size + y * BARCODE_WIDTH + x]!);
    const shown = decodeBarcode(luma);
    if (shown !== k) throw new Error(`${clip}: frame ${k} reads as ${shown ?? 'no barcode'}`);
  }
}

function framesCsv(video: string, ptsUs: readonly number[], tsNs: readonly bigint[]): string {
  const rows = ptsUs.map(
    (us, k) => `${video},${k},${(us / 1e6).toFixed(6)},${tsNs[k]},${1000 + k}`,
  );
  return `video_file,frame_index,video_time_s,source_ts_ns,source_frame_id\n${rows.join('\n')}\n`;
}
