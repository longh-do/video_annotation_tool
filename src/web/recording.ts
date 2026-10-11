/**
 * Loading a recording for annotation: its cameras, their frame maps and the saved annotation.
 * The parts that never change are cached for the last few recordings (the one on screen, the one
 * before it and the next, fetched ahead of time); the saved annotation is always fetched fresh.
 */
import type { RecordingResponse } from '../core/api-types.ts';
import { type FrameMap, parseFramesCsv } from '../core/frame-map.ts';
import {
  fetchRecording,
  fetchSaved,
  fetchText,
  type ServerAnnotation,
  supportsRanges,
} from './api.ts';
import type { Journal, JournalEntry } from './journal.ts';

export interface RecordingMedia {
  readonly info: RecordingResponse;
  /** One frame map per camera, in `info.cameras` order (the reference camera first). */
  readonly frames: readonly FrameMap[];
  /** False when the server sends the video only whole (it ignores byte ranges): no seeking. */
  readonly seekable: boolean;
}

export interface LoadedRecording extends RecordingMedia, ServerAnnotation {
  /** Changes the journal kept that may not have reached the server. */
  readonly unsaved: JournalEntry | null;
}

/** How many recordings' media stays cached: the one on screen, the one before and the next. */
const CACHED = 3;
/** The least recently asked for first. */
const media = new Map<string, Promise<RecordingMedia>>();

/** Starts fetching a recording's media unless already started, e.g. to prefetch the next one. */
export function prefetchMedia(id: string): Promise<RecordingMedia> {
  let pending = media.get(id);
  if (!pending) {
    const fetching = fetchMedia(id);
    fetching.catch(() => {
      if (media.get(id) === fetching) media.delete(id);
    });
    pending = fetching;
  }
  media.delete(id);
  media.set(id, pending);
  for (const old of [...media.keys()].slice(0, -CACHED)) media.delete(old);
  return pending;
}

export async function loadRecording(id: string, journal: Journal | null): Promise<LoadedRecording> {
  const [loaded, server, unsaved] = await Promise.all([
    prefetchMedia(id),
    fetchSaved(id),
    journal?.read(id).catch(() => null) ?? null,
  ]);
  return { ...loaded, ...server, unsaved };
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
