/**
 * The catalog: the recordings ingest found and validated, with the real paths of their files.
 * Ingest writes it to derived/catalog.json; the server only reads it. Source files are never
 * copied, moved or modified.
 */
import { readFile } from 'node:fs/promises';

export interface Catalog {
  readonly version: 1;
  readonly createdAt: string;
  /** The annotation guideline for this batch, shown in the tool and stamped on every save. */
  readonly guideline: Guideline | null;
  /** In queue order. */
  readonly recordings: readonly Recording[];
}

export interface Guideline {
  readonly path: string;
  readonly title: string;
  /** A content hash, so a save records exactly which text the annotator worked from. */
  readonly version: string;
}

export interface Recording {
  readonly id: string;
  readonly durationS: number;
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
  if (catalog.version !== 1) throw new Error(`${path}: unsupported catalog version`);
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
