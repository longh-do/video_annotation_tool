import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QueueResponse } from '../core/api-types.ts';
import { AnnotationSession } from './annotation-session.ts';
import { fetchQueue } from './api.ts';
import { canAnnotate } from './browser.ts';
import { QueueBar } from './components/QueueBar.tsx';
import { QueueOverlay } from './components/QueueOverlay.tsx';
import { Toast, type ToastMessage } from './components/Toast.tsx';
import { Journal } from './journal.ts';
import { placeFromHash } from './location.ts';
import { nextToAnnotate } from './queue.ts';
import { type LoadedRecording, loadRecording, prefetchMedia } from './recording.ts';
import { type Finished, Workspace } from './Workspace.tsx';

interface Opened {
  readonly recording: LoadedRecording;
  readonly annotation: AnnotationSession;
}

/**
 * The queue. Opens the recording the URL names (#<id> or #<id>/<frame>), else the first one not
 * yet reviewed; once an outcome is saved, the next one, fetched ahead of time so that it opens at
 * once. Each recording's annotation lives as long as the page, so going back to a recording keeps
 * its undo history.
 */
export function App() {
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [showQueue, setShowQueue] = useState(false);
  const [warm, setWarm] = useState<{ id: string; videoUrl: string } | null>(null);
  const canMark = useMemo(canAnnotate, []);
  const journal = useRef<Journal | null>(null);
  const annotations = useRef(new Map<string, AnnotationSession>());
  /** Opens in progress, so that opening a recording twice at once loads it once. */
  const loading = useRef(new Map<string, Promise<Opened>>());
  const latest = useRef<string | null>(null);

  const load = useCallback(async (id: string): Promise<Opened> => {
    // What is pending for it reaches the server first, so the revisions compared are current.
    const kept = annotations.current.get(id);
    await kept?.saver.flush();
    const recording = await loadRecording(id, journal.current);
    if (kept?.saver.revision === (recording.saved?.revision ?? 0)) {
      return { recording, annotation: kept };
    }
    kept?.dispose();
    const annotation = new AnnotationSession(recording, journal.current);
    annotations.current.set(id, annotation);
    if (annotation.recovered) setToast({ text: 'Recovered changes that had not been saved.' });
    if (annotation.discarded) {
      setToast({ text: 'Older unsaved changes were dropped: this recording was saved since.' });
    }
    return { recording, annotation };
  }, []);

  const open = useCallback(
    async (id: string) => {
      latest.current = id;
      const pending = loading.current.get(id) ?? load(id);
      loading.current.set(id, pending);
      const loaded = await pending.finally(() => loading.current.delete(id));
      if (latest.current !== id) return;
      if (placeFromHash().recordingId !== id) {
        history.replaceState(null, '', `#${encodeURIComponent(id)}`);
      }
      setOpened(loaded);
      setShowQueue(false);
    },
    [load],
  );
  const go = useCallback(
    (id: string) => void open(id).catch((reason: unknown) => setError(String(reason))),
    [open],
  );

  // The queue and the journal, then the recording the URL names or the first one to do.
  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      const [loaded, opened] = await Promise.all([fetchQueue(), Journal.open()]);
      if (cancelled) return;
      journal.current = opened;
      setQueue(loaded);
      const wanted = placeFromHash().recordingId;
      const id =
        loaded.recordings.find((r) => r.id === wanted)?.id ??
        nextToAnnotate(loaded.recordings, null) ??
        loaded.recordings[0]?.id;
      if (id) await open(id);
    };
    start().catch((reason: unknown) => setError(String(reason)));
    return () => {
      cancelled = true;
    };
  }, [open]);

  // A link to another recording in the queue opens it.
  useEffect(() => {
    const followLink = () => {
      const wanted = placeFromHash().recordingId;
      if (wanted !== latest.current && queue?.recordings.some((r) => r.id === wanted)) go(wanted);
    };
    window.addEventListener('hashchange', followLink);
    return () => window.removeEventListener('hashchange', followLink);
  }, [queue, go]);

  // Whatever is unsaved goes to the server when the page is hidden or closed; closing with
  // unsaved changes asks first.
  useEffect(() => {
    const all = () => [...annotations.current.values()];
    const flush = () => {
      for (const annotation of all()) void annotation.saver.flush(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (all().some((annotation) => annotation.saver.dirty)) event.preventDefault();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  // Fetch the next recording ahead of time and warm up its video.
  const current = opened?.recording.info.id ?? null;
  const next = queue && current ? nextToAnnotate(queue.recordings, current) : null;
  useEffect(() => {
    if (!next) return;
    let wanted = true;
    prefetchMedia(next).then(
      (media) => wanted && setWarm({ id: next, videoUrl: media.info.cameras[0]!.videoUrl }),
      () => {},
    );
    return () => {
      wanted = false;
    };
  }, [next]);

  const closeToast = useCallback(() => setToast(null), []);

  if (error) return <p className="message">Couldn't load: {error}</p>;
  if (queue?.recordings.length === 0) {
    return <p className="message">No recordings yet. Run pnpm ingest &lt;data folder&gt;.</p>;
  }
  if (!queue || !opened || !current) return <p className="message">Loading…</p>;

  const finished = async ({ id, text, undo }: Finished) => {
    const annotation = annotations.current.get(id);
    setToast({
      text,
      action: undo
        ? {
            label: 'Undo',
            run: () => {
              annotation?.editor.dispatch({ type: 'undo' });
              go(id);
            },
          }
        : { label: 'Back', run: () => go(id) },
    });
    const fresh = await fetchQueue();
    setQueue(fresh);
    const after = nextToAnnotate(fresh.recordings, id);
    if (after) go(after);
    else setShowQueue(true);
  };
  const openQueue = () => {
    setShowQueue(true);
    fetchQueue().then(setQueue, () => {});
  };

  return (
    <>
      <Workspace
        key={current}
        recording={opened.recording}
        annotation={opened.annotation}
        session={queue.session}
        canMark={canMark}
        blocked={showQueue}
        queueBar={
          <QueueBar
            position={queue.recordings.findIndex((r) => r.id === current) + 1}
            total={queue.recordings.length}
            next={next === null ? 'none' : warm?.id === next ? 'ready' : 'loading'}
            onOpenQueue={openQueue}
          />
        }
        onFinished={(result) => void finished(result).catch((e: unknown) => setError(String(e)))}
        onToast={setToast}
      />
      {showQueue && (
        <QueueOverlay
          recordings={queue.recordings}
          current={current}
          onOpen={go}
          onClose={() => setShowQueue(false)}
        />
      )}
      {toast && <Toast message={toast} onClose={closeToast} />}
      {warm && <video className="warm" src={warm.videoUrl} preload="auto" muted />}
    </>
  );
}
