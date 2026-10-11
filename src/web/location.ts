/**
 * Links to a recording, or to one frame of it: #<recording id> or #<recording id>/<frame>.
 * Reviewers can share the exact moment they mean; tests use the same links.
 */
export interface Place {
  readonly recordingId: string;
  readonly frame: number | null;
}

export function placeFromHash(hash = location.hash): Place {
  const [id = '', frame] = decodeURIComponent(hash.replace(/^#/, '')).split('/');
  return {
    recordingId: id,
    frame: frame !== undefined && /^\d+$/.test(frame) ? Number(frame) : null,
  };
}
