/**
 * The HTTP API and media routes.
 *
 *   GET  /api/queue                 recordings in queue order with their save status
 *   GET  /api/recordings/:id        cameras, media URLs, thumbnails, task
 *   GET  /api/tasks/:id             a task's guide (markdown, without its header)
 *   GET  /api/annotations/:id       the saved annotation and sidecar; ETag = revision
 *   PUT  /api/annotations/:id       save; If-Match must name the revision that was edited
 *   POST /api/events                append a batch of telemetry events
 *   GET  /media/:id/<file>          videos, frames CSVs and thumbnail sheets, with byte ranges
 *
 * Every id and file name a request mentions is looked up in the catalog, so no request path is
 * ever joined onto the filesystem.
 */
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type AnnotationFile,
  keepIntervals,
  type SidecarDraft,
  timelineFromSidecar,
  validateAnnotationFile,
  validateSidecarDraft,
} from '../core/annotation.ts';
import type { QueueResponse, RecordingResponse, SaveResult, TaskInfo } from '../core/api-types.ts';
import { type FrameMap, parseFramesCsv } from '../core/frame-map.ts';
import { type AnnotationStore, RevisionConflict, type Stamp } from './annotations.ts';
import { type Catalog, type Recording, referenceCamera } from './catalog.ts';
import { HttpError, readJson, sendJson } from './http.ts';
import { sendFile } from './media.ts';
import { guideMarkdown, guideTitle, guideVersion } from './task-guides.ts';
import type { TelemetryLog } from './telemetry.ts';

export interface ApiOptions {
  readonly catalog: Catalog;
  readonly store: AnnotationStore;
  readonly telemetry: TelemetryLog;
  readonly annotatorId: string;
  readonly toolVersion: string;
}

/** Serves API and media requests; resolves false for any other path. */
export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type Route = (req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<void>;

const MAX_EVENTS = 1000;

export function createApi(options: ApiOptions): Handler {
  const { catalog, store, telemetry } = options;
  const recordings = new Map(catalog.recordings.map((r) => [r.id, r]));
  const tasks = new Map(Object.entries(catalog.tasks));
  const frameMaps = new Map<string, Promise<FrameMap>>();

  const recordingOf = (id = ''): Recording => {
    const recording = recordings.get(id);
    if (!recording) throw new HttpError(404, `no recording ${id}`);
    return recording;
  };

  /**
   * A recording's task guide as it is on disk now, so an edited guide shows on the next reload
   * without a new ingest, and saves are stamped with the version of the text annotators see.
   * Which recordings a guide covers was settled at ingest. Null without a guide, or if its file
   * is gone.
   */
  const guideNow = async (id: string | null) => {
    const guide = id === null ? undefined : tasks.get(id);
    if (!guide || id === null) return null;
    const text = await readFile(guide.path, 'utf8').catch(() => null);
    if (text === null) return null;
    const info: TaskInfo = {
      id,
      title: guideTitle(text) ?? guide.title,
      version: guideVersion(text),
    };
    return { info, markdown: guideMarkdown(text) };
  };

  /** The reference camera's frame map, parsed once per recording (retried if reading failed). */
  const referenceFrames = (recording: Recording): Promise<FrameMap> => {
    let frames = frameMaps.get(recording.id);
    if (!frames) {
      frames = readFile(referenceCamera(recording).framesPath, 'utf8').then(parseFramesCsv);
      frames.catch(() => frameMaps.delete(recording.id));
      frameMaps.set(recording.id, frames);
    }
    return frames;
  };

  const queue: Route = async (_req, res) => {
    const items = await Promise.all(
      catalog.recordings.map(async (recording) => {
        const saved = await store.load(recording.id);
        return {
          id: recording.id,
          durationS: recording.durationS,
          status: saved?.annotation.status ?? 'not_reviewed',
          keepIntervals: saved?.annotation.keep_intervals.length ?? 0,
          savedAt: saved?.sidecar?.saved_at ?? null,
        };
      }),
    );
    const session = { annotatorId: options.annotatorId, toolVersion: options.toolVersion };
    sendJson(res, 200, { session, recordings: items } satisfies QueueResponse);
  };

  const recording: Route = async (_req, res, [id]) => {
    const r = recordingOf(id);
    const url = (file: string) => `/media/${encodeURIComponent(r.id)}/${file}`;
    sendJson(res, 200, {
      id: r.id,
      durationS: r.durationS,
      task: (await guideNow(r.task))?.info ?? null,
      cameras: r.cameras.map((c) => ({
        name: c.name,
        label: c.label,
        video: c.video,
        videoUrl: url(c.video),
        framesUrl: url(`${c.label}-frames.csv`),
        frameCount: c.frameCount,
        width: c.width,
        height: c.height,
      })),
      thumbnails: r.thumbnails && {
        tileWidth: r.thumbnails.tileWidth,
        tileHeight: r.thumbnails.tileHeight,
        columns: r.thumbnails.columns,
        rows: r.thumbnails.rows,
        sheetUrls: r.thumbnails.sheetPaths.map((path) => url(basename(path))),
        frames: r.thumbnails.frames,
      },
    } satisfies RecordingResponse);
  };

  const taskGuide: Route = async (_req, res, [id = '']) => {
    const guide = tasks.has(id) ? await guideNow(id) : null;
    if (!guide) throw new HttpError(404, `no task ${id}`);
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(guide.markdown);
  };

  const getAnnotation: Route = async (_req, res, [id]) => {
    const r = recordingOf(id);
    const saved = await store.load(r.id);
    if (!saved) {
      const revision = await store.revision(r.id);
      return sendJson(res, 404, { revision }, { ETag: `"${revision}"` });
    }
    sendJson(res, 200, saved, { ETag: `"${saved.revision}"` });
  };

  const putAnnotation: Route = async (req, res, [id]) => {
    const r = recordingOf(id);
    const base = /^"(\d+)"$/.exec(req.headers['if-match'] ?? '')?.[1];
    if (base === undefined) throw new HttpError(428, 'send If-Match with the revision you edited');
    const body = await readJson(req);
    const { annotation, sidecar } = (body ?? {}) as { annotation?: unknown; sidecar?: unknown };
    const frames = await referenceFrames(r);
    const reference = { recordingId: r.id, referenceVideo: referenceCamera(r).video, frames };
    const problems = [
      ...validateAnnotationFile(annotation, reference),
      ...validateSidecarDraft(sidecar, frames).map((problem) => `sidecar: ${problem}`),
    ];
    if (problems.length === 0) {
      problems.push(...agreement(annotation as AnnotationFile, sidecar as SidecarDraft, frames));
    }
    if (problems.length > 0) throw new HttpError(400, 'invalid annotation', { problems });
    // Each recording is annotated against its own task's guide.
    const stamp: Stamp = {
      annotatorId: options.annotatorId,
      guidelineVersion: (await guideNow(r.task))?.info.version ?? null,
      toolVersion: options.toolVersion,
    };
    try {
      const saved = await store.save(
        r.id,
        Number(base),
        annotation as AnnotationFile,
        sidecar as SidecarDraft,
        stamp,
      );
      const result: SaveResult = { revision: saved.revision, savedAt: saved.saved_at };
      sendJson(res, 200, result, { ETag: `"${saved.revision}"` });
    } catch (error) {
      if (error instanceof RevisionConflict) {
        throw new HttpError(412, error.message, { revision: error.current });
      }
      throw error;
    }
  };

  const postEvents: Route = async (req, res) => {
    const batch = await readJson(req, 1_000_000);
    const valid =
      Array.isArray(batch) &&
      batch.length <= MAX_EVENTS &&
      batch.every((e) => typeof e === 'object' && e !== null && typeof e.event === 'string');
    if (!valid) throw new HttpError(400, `send a JSON array of at most ${MAX_EVENTS} named events`);
    await telemetry.append(batch);
    res.writeHead(204).end();
  };

  const media: Route = async (req, res, [id, file]) => {
    const r = recordingOf(id);
    const camera = r.cameras.find((c) => c.video === file || `${c.label}-frames.csv` === file);
    const sheet = r.thumbnails?.sheetPaths.find((path) => basename(path) === file);
    let path = sheet;
    let cache = 'private, max-age=3600';
    if (camera) {
      const isVideo = camera.video === file;
      path = isVideo ? camera.videoPath : camera.framesPath;
      cache = isVideo ? cache : 'no-store';
    }
    if (!path) throw new HttpError(404, `recording ${r.id} has no file ${file}`);
    try {
      await sendFile(req, res, path, cache);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new HttpError(404, `${file} is in the catalog but missing on disk; run ingest again`);
    }
  };

  const routes: [method: string, pattern: RegExp, route: Route][] = [
    ['GET', /^\/api\/queue$/, queue],
    ['GET', /^\/api\/recordings\/([^/]+)$/, recording],
    ['GET', /^\/api\/tasks\/([^/]+)$/, taskGuide],
    ['GET', /^\/api\/annotations\/([^/]+)$/, getAnnotation],
    ['PUT', /^\/api\/annotations\/([^/]+)$/, putAnnotation],
    ['POST', /^\/api\/events$/, postEvents],
    ['GET', /^\/media\/([^/]+)\/(.+)$/, media],
  ];

  return async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!path.startsWith('/api/') && !path.startsWith('/media/')) return false;
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      const matching = routes.flatMap(([m, pattern, route]) => {
        const match = pattern.exec(path);
        return match ? [{ m, route, params: match.slice(1).map(decodeURIComponent) }] : [];
      });
      const hit = matching.find((candidate) => candidate.m === method);
      if (hit) await hit.route(req, res, hit.params);
      else if (matching.length > 0) throw new HttpError(405, `${req.method} is not allowed here`);
      else throw new HttpError(404, `nothing at ${path}`);
    } catch (error) {
      if (error instanceof HttpError) sendJson(res, error.status, error.body, error.headers);
      else if (error instanceof URIError || isInvalidUrl(error)) {
        sendJson(res, 400, { error: 'malformed URL' });
      } else throw error;
    }
    return true;
  };
}

function isInvalidUrl(error: unknown): boolean {
  return error instanceof TypeError && (error as NodeJS.ErrnoException).code === 'ERR_INVALID_URL';
}

/** The contract file must be exactly what the sidecar's boundaries produce. */
function agreement(annotation: AnnotationFile, sidecar: SidecarDraft, frames: FrameMap): string[] {
  const problems: string[] = [];
  const derived = keepIntervals(timelineFromSidecar(sidecar.boundaries, frames), frames);
  if (!isDeepStrictEqual(derived, annotation.keep_intervals)) {
    problems.push("keep_intervals don't match the sidecar's boundaries");
  }
  if ((annotation.status === 'needs_review') !== (sidecar.review_reason !== null)) {
    problems.push('a review reason goes with status needs_review, and only with it');
  }
  return problems;
}
