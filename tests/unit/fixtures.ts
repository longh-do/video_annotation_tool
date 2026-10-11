/** Synthetic recording folders on disk, laid out like the real downloads. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { framesCsv } from './synthetic.ts';

export interface RecordingFixture {
  readonly id: string;
  /**
   * `together`: manifest, frames CSVs and videos/ in one folder.
   * `split`: manifest and CSVs in annotation-data/, beside videos/ (the long recording's layout).
   */
  readonly layout?: 'together' | 'split';
  readonly frames?: number;
  /** Write an annotation template naming this recording id. */
  readonly templateId?: string;
}

export interface WrittenRecording {
  readonly manifestPath: string;
  /** Presentation timestamps (µs) of each video's frames, keyed by video path. */
  readonly pts: ReadonlyMap<string, readonly number[]>;
}

const CAMERAS = [
  ['umi.head.camera.enc', 'head', 3_000_000_000_000n],
  ['umi.left.camera.enc', 'left', 2_999_976_000_000n],
  ['umi.right.camera.enc', 'right', 2_999_972_500_000n],
] as const;

/** The temporary folders this test file made; they are removed once its tests are done. */
const made: string[] = [];
afterAll(() => Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'video-annotation-tool-'));
  made.push(dir);
  return dir;
}

export async function writeRecording(
  root: string,
  fixture: RecordingFixture,
): Promise<WrittenRecording> {
  const folder = join(root, fixture.id);
  const metaDir = fixture.layout === 'split' ? join(folder, 'annotation-data') : folder;
  await mkdir(join(folder, 'videos'), { recursive: true });
  await mkdir(metaDir, { recursive: true });
  const frames = fixture.frames ?? 50;
  const pts = new Map<string, number[]>();
  const cameras: Record<string, unknown[]> = {};

  for (const [i, [name, label, startNs]] of CAMERAS.entries()) {
    const gapsUs = Array.from({ length: frames - 1 }, (_, k) => 30_000 + ((k * 7 + i) % 5) * 2_500);
    const file = `${label}-0000.mp4`;
    await writeFile(join(metaDir, `${label}-frames.csv`), framesCsv([{ file, startNs, gapsUs }]));
    const videoPath = join(folder, 'videos', file);
    await writeFile(videoPath, `not really a ${label} video`);
    let us = 0;
    pts.set(videoPath, [0, ...gapsUs.map((gap) => (us += gap))]);
    const lastUs = gapsUs.reduce((a, b) => a + b, 0);
    cameras[name] = [
      {
        file: `videos/${file}`,
        source_start_ns: String(startNs),
        frames,
        width: 640,
        height: 480,
        source_last_frame_ns: String(
          startNs + BigInt(lastUs) * 1000n + BigInt(((frames - 1) * 7919) % 1000),
        ),
      },
    ];
  }

  const manifest = {
    recording_id: fixture.id,
    recording_duration_s: 2.5,
    default_camera: 'umi.head.camera.enc',
    cameras,
  };
  const manifestPath = join(metaDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  // Stray decompressed copies, as in two of the real downloads: ingest must ignore them.
  await writeFile(join(metaDir, 'alignment.jsonl'), '{}\n');
  if (fixture.templateId) {
    const template = { recording_id: fixture.templateId, reference_video: 'videos/head-0000.mp4' };
    await writeFile(join(folder, 'annotation-template.json'), JSON.stringify(template));
  }
  return { manifestPath, pts };
}
