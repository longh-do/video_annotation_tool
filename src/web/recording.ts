/**
 * Loading a recording for annotation: its cameras, their frame maps and the saved annotation.
 * The parts that never change are cached, so the next recording can be fetched ahead of time;
 * the saved annotation is always fetched fresh.
 */
import type { RecordingResponse, SavedAnnotation } from '../core/api-types.ts';
import { type FrameMap, parseFramesCsv } from '../core/frame-map.ts';
import { fetchRecording, fetchSaved, fetchText, supportsRanges } from './api.ts';
import type { Journal, JournalEntry } from './journal.ts';

export interface RecordingMedia {
  readonly info: RecordingResponse;
  /** One frame map per camera, in `info.cameras` order (the reference camera first). */
  readonly frames: readonly FrameMap[];
  /** False when the server ignores byte ranges, so seeking would not work. */
  readonly seekable: boolean;
}

export interface LoadedRecording extends RecordingMedia {
  readonly saved: SavedAnnotation | null;
  /** Changes the journal kept that may not have reached the server. */
  readonly unsaved: JournalEntry | null;
}

const media = new Map<string, Promise<RecordingMedia>>();

/** Starts fetching a recording's media (no-op if already started); used to prefetch the next one. */
export function prefetchMedia(id: string): Promise<RecordingMedia> {
  let pending = media.get(id);
  if (!pending) {
    pending = fetchMedia(id);
    pending.catch(() => media.delete(id));
    media.set(id, pending);
  }
  return pending;
}

export async function loadRecording(id: string, journal: Journal | null): Promise<LoadedRecording> {
  const [loaded, saved, unsaved] = await Promise.all([
    prefetchMedia(id),
    fetchSaved(id),
    journal?.read(id).catch(() => null) ?? null,
  ]);
  return { ...loaded, saved, unsaved };
}

async function fetchMedia(id: string): Promise<RecordingMedia> {
  const info = await fetchRecording(id);
  const reference = info.cameras[0];
  if (!reference) throw new Error(`recording ${id} has no cameras`);
  const [frames, seekable] = await Promise.all([
    Promise.all(info.cameras.map(async (c) => parseFramesCsv(await fetchText(c.framesUrl)))),
    supportsRanges(reference.videoUrl),
  ]);
  return { info, frames, seekable };
}
