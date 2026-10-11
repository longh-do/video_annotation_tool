/**
 * The catalog: the recordings ingest found and validated, with the real paths of their files.
 * Ingest writes it to derived/catalog.json; the server only reads it. Recording files are never
 * copied, moved or modified.
 */
import { readFile } from 'node:fs/promises';

export interface Catalog {
  readonly version: 2;
  readonly createdAt: string;
  /** Task guides by id (the file name without .md). */
  readonly tasks: Readonly<Record<string, TaskGuide>>;
  /** In queue order. */
  readonly recordings: readonly Recording[];
}

/** What to keep in a task's recordings, shown beside them and stamped on every save. */
export interface TaskGuide {
  readonly path: string;
  readonly title: string;
  /** A content hash, so a save records exactly which text the annotator worked from. */
  readonly version: string;
  /** Recording-id patterns from the guide's header. */
  readonly recordings: readonly string[];
}

export interface Recording {
  readonly id: string;
  readonly durationS: number;
  /** The task guide that covers it, or null. */
  readonly task: string | null;
  /** Cameras, the reference camera (the one annotated) first. */
  readonly cameras: readonly Camera[];
  readonly thumbnails: Thumbnails | null;
  readonly warnings: readonly string[];
}

export interface Camera {
  /** Stream name from the manifest, e.g. `umi.head.camera.enc`. */
  readonly name: string;
  /** Short name from the video file, e.g. `head`. */
  readonly label: string;
  /** Manifest-relative path, e.g. `videos/head-0000.mp4`; the reference camera's is `reference_video`. */
  readonly video: string;
  readonly videoPath: string;
  readonly framesPath: string;
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
}

/** Keyframe thumbnails of the reference camera, packed into sprite sheets. */
export interface Thumbnails {
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly columns: number;
  readonly rows: number;
  readonly sheetPaths: readonly string[];
  /** The reference frame each thumbnail shows, in sheet order. */
  readonly frames: readonly number[];
}

export async function readCatalog(path: string): Promise<Catalog> {
  const catalog = JSON.parse(await readFile(path, 'utf8')) as Catalog;
  if (catalog.version !== 2) {
    throw new Error(`${path} was written by an older version: run pnpm ingest again`);
  }
  return catalog;
}

/**
 * Recording ids become file and folder names (annotations, thumbnails), so only plain names pass:
 * letters, digits, `-`, `_` and `.`, not starting with a dot.
 */
export function isSafeRecordingId(id: string): boolean {
  return /^[\w-][\w.-]*$/.test(id);
}

export function referenceCamera(recording: Recording): Camera {
  const camera = recording.cameras[0];
  if (!camera) throw new Error(`recording ${recording.id} has no cameras`);
  return camera;
}
