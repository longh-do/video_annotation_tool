import { useEffect, useMemo, useState } from 'react';
import type { QueueResponse } from '../core/api-types.ts';
import { fetchQueue } from './api.ts';
import { canAnnotate } from './browser.ts';
import { placeFromHash } from './location.ts';
import { type LoadedRecording, loadRecording } from './recording.ts';
import { Workspace } from './Workspace.tsx';

/**
 * Opens the recording the URL names (#<id> or #<id>/<frame>), else the first one not yet
 * reviewed. A link to another recording opens it.
 */
export function App() {
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [recording, setRecording] = useState<LoadedRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canMark = useMemo(canAnnotate, []);

  useEffect(() => {
    let latest: QueueResponse | null = null;
    let openId: string | null = null;
    const open = async (id: string) => {
      openId = id;
      const loaded = await loadRecording(id);
      if (openId === id) setRecording(loaded);
    };
    const start = async () => {
      latest = await fetchQueue();
      setQueue(latest);
      const wanted = placeFromHash().recordingId;
      const id =
        latest.recordings.find((r) => r.id === wanted)?.id ??
        latest.recordings.find((r) => r.status === 'not_reviewed')?.id ??
        latest.recordings[0]?.id;
      if (id) await open(id);
    };
    const followLink = () => {
      const wanted = placeFromHash().recordingId;
      if (wanted !== openId && latest?.recordings.some((r) => r.id === wanted)) {
        open(wanted).catch((reason: unknown) => setError(String(reason)));
      }
    };
    start().catch((reason: unknown) => setError(String(reason)));
    window.addEventListener('hashchange', followLink);
    return () => window.removeEventListener('hashchange', followLink);
  }, []);

  if (error) return <p className="message">Couldn't load: {error}</p>;
  if (queue?.recordings.length === 0) {
    return <p className="message">No recordings yet. Run pnpm ingest &lt;data folder&gt;.</p>;
  }
  if (!queue || !recording) return <p className="message">Loading…</p>;
  return (
    <Workspace
      key={recording.info.id}
      recording={recording}
      session={queue.session}
      canMark={canMark}
    />
  );
}
