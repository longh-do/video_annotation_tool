/** The server API, typed with the shapes the server shares. */
import type {
  ErrorBody,
  GuideResponse,
  QueueResponse,
  RecordingResponse,
  SavedAnnotation,
  SavePayload,
  SaveResult,
} from '../core/api-types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly body: ErrorBody;
  constructor(status: number, body: ErrorBody) {
    super(body.error ?? body.problems?.join('; ') ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body as ErrorBody);
  return body as T;
}

export const fetchQueue = () => request<QueueResponse>('/api/queue');

export const fetchRecording = (id: string) =>
  request<RecordingResponse>(`/api/recordings/${encodeURIComponent(id)}`);

/** The saved annotation, or null if there is none yet. */
export async function fetchSaved(id: string): Promise<SavedAnnotation | null> {
  try {
    return await request<SavedAnnotation>(`/api/annotations/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Saves on top of `revision`; a stale revision fails with ApiError 412. `keepalive` lets the
 * request finish after the page is gone (closing the tab mid-save).
 */
export const saveAnnotation = (
  id: string,
  revision: number,
  payload: SavePayload,
  keepalive = false,
) =>
  request<SaveResult>(`/api/annotations/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': `"${revision}"` },
    body: JSON.stringify(payload),
    keepalive,
  });

/** A task's guide as it is now, so an edit of its file shows on the next load. */
export const fetchGuide = (id: string) =>
  request<GuideResponse>(`/api/tasks/${encodeURIComponent(id)}`);

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok)
    throw new ApiError(response.status, { error: `${url}: HTTP ${response.status}` });
  return response.text();
}

/** Seeking needs byte ranges; check the media server really answers them before annotating. */
export async function supportsRanges(videoUrl: string): Promise<boolean> {
  const response = await fetch(videoUrl, { headers: { Range: 'bytes=0-1' } });
  await response.body?.cancel();
  return response.status === 206;
}
