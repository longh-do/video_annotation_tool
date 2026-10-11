/**
 * Ingest: find every recording under a data folder, check it, and write the catalog.
 *
 * Two folder layouts occur. Usually the manifest, frames CSVs and `videos/` sit together. The long
 * recording was unzipped with its manifest and CSVs in a subfolder beside `videos/`, so a video
 * path the manifest gives relative to itself is also looked up one folder up. Nothing is moved,
 * and nothing is written inside the data folder.
 *
 * Checks, any of which rejects a recording: the manifest is well formed; each camera's frames CSV
 * parses, has the manifest's frame count and first/last timestamps, and (when ffprobe is
 * installed) lists exactly the video's packet timestamps. Warnings don't reject: e.g. an
 * annotation template naming another recording, which happens in the provided data — the
 * manifest is the source of truth. One broken folder never stops the others.
 *
 * Given a folder of task guides (task-guides.ts), each recording also gets its task: the first
 * guide that covers it, with a warning when several or none do.
 */
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { displayedFrame, type FrameMap, frameCount, parseFramesCsv } from '../core/frame-map.ts';
import { isNsString } from '../core/ns.ts';
import {
  type Camera,
  type Catalog,
  isSafeRecordingId,
  type Recording,
  type TaskGuide,
} from './catalog.ts';
import { type MediaTools, SHEET_NAME, SPRITE_GRID } from './ffmpeg.ts';
import { readTaskGuides, tasksCovering } from './task-guides.ts';

export interface Inspection {
  readonly manifestPath: string;
  /** Null when the recording was rejected. */
  readonly recording: Recording | null;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface IngestOptions {
  readonly dataDir: string;
  readonly outDir: string;
  /** The folder of task guides, or null for none. */
  readonly tasksDir: string | null;
  /** ffprobe/ffmpeg, or null to skip the video checks and thumbnails. */
  readonly tools: MediaTools | null;
}

const TILE_WIDTH = 96;

interface ManifestPart {
  readonly file: string;
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly source_start_ns: string;
  readonly source_last_frame_ns: string;
}

interface Manifest {
  readonly recording_id: string;
  readonly recording_duration_s: number;
  readonly default_camera: string;
  readonly cameras: Readonly<Record<string, readonly ManifestPart[]>>;
}

/** `taskWarnings` are about the task guides themselves; recordings carry their own warnings. */
export async function ingest(
  options: IngestOptions,
): Promise<{ catalog: Catalog; inspections: Inspection[]; taskWarnings: string[] }> {
  const outDir = resolve(options.outDir);
  const dataDir = resolve(options.dataDir);
  // Each recording's thumbnails replace a folder named after it: never among the recordings.
  if (isInside(outDir, dataDir)) {
    throw new Error(`the output folder ${outDir} is inside the data folder ${dataDir}`);
  }
  const guides = options.tasksDir === null ? null : await readTaskGuides(options.tasksDir);
  const inspections: Inspection[] = [];
  const seen = new Set<string>();
  for (const manifestPath of await findManifests(options.dataDir)) {
    const inspection = await inspectRecording(manifestPath, options.tools);
    const recording = inspection.recording;
    if (recording && seen.has(recording.id)) {
      inspections.push({
        ...inspection,
        recording: null,
        errors: [`duplicate recording ${recording.id}`],
      });
    } else {
      if (recording) seen.add(recording.id);
      inspections.push(inspection);
    }
  }

  const recordings: Recording[] = [];
  for (const [i, inspection] of inspections.entries()) {
    if (!inspection.recording) continue;
    let recording = inspection.recording;
    if (guides) recording = withTask(recording, guides.tasks);
    if (options.tools) recording = await withThumbnails(recording, outDir, options.tools);
    inspections[i] = { ...inspection, recording, warnings: recording.warnings };
    recordings.push(recording);
  }

  const catalog: Catalog = {
    version: 2,
    createdAt: new Date().toISOString(),
    tasks: Object.fromEntries(guides?.tasks ?? []),
    recordings,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  return { catalog, inspections, taskWarnings: guides?.warnings ?? [] };
}

/** Whether `path` is `folder` or inside it. */
export function isInside(path: string, folder: string): boolean {
  const rel = relative(resolve(folder), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Every manifest.json under `dir`, in path order (the downloads are numbered 01, 02, …). */
export async function findManifests(dir: string, depth = 5): Promise<string[]> {
  if (depth < 0) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        return findManifests(path, depth - 1);
      }
      return entry.isFile() && entry.name === 'manifest.json' ? [resolve(path)] : [];
    }),
  );
  return found.flat().sort();
}

/** Checks one recording; never throws, so one broken folder can't stop the others. */
export async function inspectRecording(
  manifestPath: string,
  tools: MediaTools | null,
): Promise<Inspection> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dir = dirname(manifestPath);
  try {
    const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
    const id = manifest.recording_id;
    const templateNote = await templateWarning(dir, id);
    if (templateNote) warnings.push(templateNote);

    const others = Object.keys(manifest.cameras).filter((name) => name !== manifest.default_camera);
    const cameras: Camera[] = [];
    for (const name of [manifest.default_camera, ...others]) {
      const result = await inspectCamera(dir, name, manifest.cameras[name] ?? [], tools);
      if (typeof result === 'string') errors.push(`${name}: ${result}`);
      else cameras.push(result);
    }
    if (errors.length === 0) {
      const durationS = manifest.recording_duration_s;
      const recording: Recording = {
        id,
        durationS,
        task: null,
        cameras,
        thumbnails: null,
        warnings,
      };
      return { manifestPath, recording, errors, warnings };
    }
  } catch (error) {
    errors.push(message(error));
  }
  return { manifestPath, recording: null, errors, warnings };
}

/** The camera's catalog entry, or what is wrong with it. */
async function inspectCamera(
  dir: string,
  name: string,
  parts: readonly ManifestPart[],
  tools: MediaTools | null,
): Promise<Camera | string> {
  const part = parts[0];
  if (!part || parts.length !== 1) {
    return `${parts.length} video parts; only single-part cameras are supported`;
  }
  const label = basename(part.file).replace(/(-\d+)?\.mp4$/, '');
  const videoPath = await firstExisting([join(dir, part.file), join(dir, '..', part.file)]);
  if (!videoPath) return `${part.file} not found next to the manifest or one folder up`;
  const framesPath = join(dir, `${label}-frames.csv`);
  let frames: FrameMap;
  try {
    frames = parseFramesCsv(await readFile(framesPath, 'utf8'));
  } catch (error) {
    return message(error);
  }
  const problem =
    frameMapProblem(frames, part) ?? (tools ? await videoProblem(frames, videoPath, tools) : null);
  if (problem) return problem;
  const { width, height } = part;
  return {
    name,
    label,
    video: part.file,
    videoPath,
    framesPath,
    frameCount: part.frames,
    width,
    height,
  };
}

function frameMapProblem(frames: FrameMap, part: ManifestPart): string | null {
  const files = frames.parts.map((p) => p.file);
  if (files.length !== 1 || files[0] !== basename(part.file)) {
    return `frames CSV describes ${files.join(', ')}, not ${part.file}`;
  }
  if (frameCount(frames) !== part.frames) {
    return `frames CSV has ${frameCount(frames)} frames, the manifest ${part.frames}`;
  }
  const first = String(frames.tsNs[0]);
  const last = String(frames.tsNs[frames.tsNs.length - 1]);
  if (first !== part.source_start_ns || last !== part.source_last_frame_ns) {
    return `frames CSV runs ${first}…${last}, the manifest ${part.source_start_ns}…${part.source_last_frame_ns}`;
  }
  return null;
}

/**
 * The frames CSV must list exactly the video's timestamps, or the frame shown isn't the frame
 * saved.
 */
async function videoProblem(
  frames: FrameMap,
  videoPath: string,
  tools: MediaTools,
): Promise<string | null> {
  const probe = await tools.probe(videoPath);
  if (probe.timeBase !== '1/1000000')
    return `video time base ${probe.timeBase}, expected 1/1000000`;
  if (probe.pts.length !== frameCount(frames)) {
    return `video has ${probe.pts.length} frames, its frames CSV ${frameCount(frames)}`;
  }
  const k = probe.pts.findIndex((pts, i) => pts !== frames.ptsUs[i]);
  if (k < 0) return null;
  return `frame ${k} is at ${probe.pts[k]} µs in the video, ${frames.ptsUs[k]} µs in its frames CSV`;
}

/** The recording's task: the first guide, by file name, that covers it. */
function withTask(recording: Recording, tasks: ReadonlyMap<string, TaskGuide>): Recording {
  const covering = tasksCovering(recording.id, tasks);
  const task = covering[0] ?? null;
  const warnings = [...recording.warnings];
  if (task === null) warnings.push('no task guide covers this recording');
  if (covering.length > 1) {
    warnings.push(`covered by several task guides (${covering.join(', ')}); using ${task}`);
  }
  return { ...recording, task, warnings };
}

/**
 * Keyframe thumbnails of the reference camera, built in a temporary folder and moved into place
 * only when complete. They replace the recording's earlier thumbnails, but never a folder that
 * holds anything else. They are a navigation aid: if ffmpeg fails, the recording goes on without.
 */
async function withThumbnails(
  recording: Recording,
  outDir: string,
  tools: MediaTools,
): Promise<Recording> {
  const reference = recording.cameras[0];
  if (!reference) return recording;
  await mkdir(outDir, { recursive: true });
  const temp = await mkdtemp(join(outDir, '.thumbnails-'));
  try {
    const sprites = await tools.sprites(reference.videoPath, temp, TILE_WIDTH);
    const frames = parseFramesCsv(await readFile(reference.framesPath, 'utf8'));
    const finalDir = join(outDir, recording.id);
    if (!(await holdsOnlySheets(finalDir))) {
      throw new Error(`${finalDir} holds more than thumbnails; left it alone`);
    }
    await rm(finalDir, { recursive: true, force: true });
    await rename(temp, finalDir);
    const thumbnails = {
      tileWidth: TILE_WIDTH,
      tileHeight: 2 * Math.round((TILE_WIDTH * reference.height) / reference.width / 2),
      columns: SPRITE_GRID,
      rows: SPRITE_GRID,
      sheetPaths: sprites.sheetPaths.map((path) => join(finalDir, basename(path))),
      frames: sprites.pts.map((pts) => displayedFrame(frames, 0, pts / 1e6)),
    };
    return { ...recording, thumbnails };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    return { ...recording, warnings: [...recording.warnings, `no thumbnails: ${message(error)}`] };
  }
}

/** Whether `dir` is missing or holds nothing but sprite sheets: thumbnails ingest wrote. */
async function holdsOnlySheets(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.every((entry) => entry.isFile() && SHEET_NAME.test(entry.name));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function parseManifest(text: string): Manifest {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error('manifest.json is not a JSON object');
  const { recording_id: id, recording_duration_s: duration, default_camera, cameras } = value;
  if (typeof id !== 'string' || !isSafeRecordingId(id)) {
    throw new Error(
      `manifest.json: recording_id ${JSON.stringify(id)} is missing or not a plain name`,
    );
  }
  if (typeof duration !== 'number' || !(duration >= 0)) {
    throw new Error('manifest.json: recording_duration_s is missing');
  }
  if (!isRecord(cameras) || typeof default_camera !== 'string' || !(default_camera in cameras)) {
    throw new Error('manifest.json names no default camera among its cameras');
  }
  for (const [name, parts] of Object.entries(cameras)) {
    if (!Array.isArray(parts) || !parts.every(isManifestPart)) {
      throw new Error(`manifest.json: camera ${name} has malformed video parts`);
    }
  }
  return value as unknown as Manifest;
}

function isManifestPart(value: unknown): value is ManifestPart {
  if (!isRecord(value) || typeof value.file !== 'string') return false;
  const counts = [value.frames, value.width, value.height];
  return (
    counts.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0) &&
    isNsString(value.source_start_ns) &&
    isNsString(value.source_last_frame_ns)
  );
}

/**
 * A warning when an annotation template beside the manifest (or one up) names another recording.
 */
async function templateWarning(dir: string, id: string): Promise<string | null> {
  const candidates = [
    join(dir, 'annotation-template.json'),
    join(dir, '..', 'annotation-template.json'),
  ];
  const path = await firstExisting(candidates);
  if (!path) return null;
  try {
    const template: unknown = JSON.parse(await readFile(path, 'utf8'));
    const named = isRecord(template) ? template.recording_id : undefined;
    if (typeof named !== 'string' || named === id) return null;
    return `annotation-template.json names ${named}; using ${id} from manifest.json`;
  } catch {
    return 'annotation-template.json is not valid JSON; ignored it';
  }
}

async function firstExisting(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await access(path);
      return resolve(path);
    } catch {}
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
