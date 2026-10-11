/** Reading and resetting saved annotations through the real API, for test setup and checks. */
import { type APIRequestContext, expect } from '@playwright/test';
import type { SavedAnnotation } from '../../src/core/api-types.ts';

export async function savedAnnotation(
  request: APIRequestContext,
  id: string,
): Promise<SavedAnnotation | null> {
  const response = await request.get(`/api/annotations/${id}`);
  return response.ok() ? ((await response.json()) as SavedAnnotation) : null;
}

/** Puts a recording back to an empty draft that opens at frame 0 (a no-op if never saved). */
export async function resetAnnotation(request: APIRequestContext, id: string): Promise<void> {
  const current = await savedAnnotation(request, id);
  if (!current?.sidecar) return;
  const { schema_version, frame_count, effort } = current.sidecar;
  const response = await request.put(`/api/annotations/${id}`, {
    headers: { 'If-Match': `"${current.revision}"` },
    data: {
      annotation: { ...current.annotation, status: 'not_reviewed', keep_intervals: [], notes: '' },
      sidecar: {
        schema_version,
        frame_count,
        boundaries: [],
        review_reason: null,
        resume: { frame: 0, playback_rate: 2 },
        effort,
      },
    },
  });
  expect(response.ok()).toBe(true);
}
