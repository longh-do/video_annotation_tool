import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QueueResponse } from '../core/api-types.ts';
import { fetchQueue } from './api.ts';
import { canAnnotate } from './browser.ts';
import type { Decision } from './components/OutcomeQuestion.tsx';
import { QueueBar } from './components/QueueBar.tsx';
import { QueueOverlay } from './components/QueueOverlay.tsx';
import { Toast, type ToastMessage } from './components/Toast.tsx';
import { Journal } from './journal.ts';
import { placeFromHash } from './location.ts';
import { nextToAnnotate } from './queue.ts';
import { prefetchMedia } from './recording.ts';
import { type Opened, Sessions } from './sessions.ts';
import { Telemetry } from './telemetry.ts';
import { Workspace } from './Workspace.tsx';

/**
 * The queue. Opens the recording the URL names (#<id> or #<id>/<frame>), else the first one not
 * yet reviewed; once an outcome is saved, the next one, fetched ahead of time so that it opens at
 * once. Keys stay off from the outcome until the next recording is on screen, so nothing typed
 * in between lands on the wrong one.
 */
export function App() {
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [showQueue, setShowQueue] = useState(false);
  const [handingOver, setHandingOver] = useState(false);
  const [warm, setWarm] = useState<{ id: string; videoUrl: string } | null>(null);
  const canMark = useMemo(canAnnotate, []);
  const sessions = useRef<Sessions | null>(null);
  /** The recording asked for last: an older open that finishes later is dropped. */
  const latest = useRef<string | null>(null);
  /** Counts hand-overs, so that a superseded one doesn't turn the keys back on for a newer one. */
  const handOvers = useRef(0);

  /**
   * Opens a recording. A failure is told and the screen stays as it was; `replaced` means a
   * newer open (a link, Back on a toast) came first.
   */
  const open = useCallback(async (id: string): Promise<'opened' | 'replaced' | 'failed'> => {
    latest.current = id;
    try {
      const loaded = await sessions.current!.open(id);
      if (latest.current !== id) return 'replaced';
      if (placeFromHash().recordingId !== id) {
        history.replaceState(null, '', `#${encodeURIComponent(id)}`);
      }
      setOpened(loaded);
      setShowQueue(false);
      // Whatever was being handed over, the screen now shows a recording to work on.
      setHandingOver(false);
      if (loaded.fresh && loaded.annotation.recovered) {
        setToast({ text: 'Recovered changes that had not been saved.' });
      } else if (loaded.fresh && loaded.annotation.discarded) {
        setToast({ text: 'Older unsaved changes were dropped: this recording was saved since.' });
      }
      return 'opened';
    } catch (reason) {
      if (latest.current !== id) return 'replaced';
      setToast({
        text: `Couldn't open ${id}: ${reason instanceof Error ? reason.message : reason}`,
      });
      return 'failed';
    }
  }, []);
  const go = useCallback((id: string) => void open(id), [open]);
  const refreshQueue = useCallback(() => fetchQueue().then(setQueue, () => {}), []);

  // The queue and the journal, then the recording the URL names or the first one to do.
  useEffect(() => {
    let cancelled = false;
    let telemetry: Telemetry | null = null;
    const start = async () => {
      const [loaded, journal] = await Promise.all([fetchQueue(), Journal.open()]);
      if (cancelled) return;
      const { annotatorId, toolVersion } = loaded.session;
      telemetry = new Telemetry({ annotatorId, toolVersion });
      sessions.current = new Sessions(journal, telemetry);
      setQueue(loaded);
      const wanted = placeFromHash().recordingId;
      const id =
        loaded.recordings.find((r) => r.id === wanted)?.id ??
        nextToAnnotate(loaded.recordings, null) ??
        loaded.recordings[0]?.id;
      if (id && (await open(id)) === 'failed') setError(`couldn't open ${id}`);
    };
    start().catch((reason: unknown) => setError(String(reason)));
    return () => {
      cancelled = true;
      telemetry?.dispose();
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
    const flush = () => sessions.current?.flushAll(true);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (sessions.current?.dirty) event.preventDefault();
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

  // The recording on screen stays in memory, and stays this tab's, whatever opens meanwhile.
  useEffect(() => (current ? sessions.current?.hold(current) : undefined), [current]);

  const closeToast = useCallback(
    (message: ToastMessage) => setToast((shown) => (shown === message ? null : shown)),
    [],
  );

  if (error) {
    return (
      <div className="message">
        <p>Couldn't load: {error}</p>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
  if (queue?.recordings.length === 0) {
    return <p className="message">No recordings yet. Run pnpm ingest &lt;data folder&gt;.</p>;
  }
  if (!queue || !opened || !current) return <p className="message">Loading…</p>;

  /** Saves the outcome, then opens the next recording; keys are off all the while. */
  const handOver = async ({ action, text, undo }: Decision) => {
    const { annotation } = opened;
    const mine = ++handOvers.current;
    setHandingOver(true);
    try {
      if (!(await annotation.finish(action))) {
        setToast({
          text: 'Not saved yet, so this recording stays open. The save status says why.',
        });
        return;
      }
      setToast({
        text,
        // Its Undo or Back returns to this recording, as it was: keep it until the message goes.
        hold: () => sessions.current?.hold(current) ?? (() => {}),
        action: undo
          ? {
              label: 'Undo',
              run: () => {
                annotation.editor.dispatch({ type: 'undo' });
                go(current);
              },
            }
          : { label: 'Back', run: () => go(current) },
      });
      // This recording's status is known; the server's full list follows in the background.
      const { status } = annotation.editor.getState().outcome;
      const recordings = queue.recordings.map((r) => (r.id === current ? { ...r, status } : r));
      setQueue({ ...queue, recordings });
      void refreshQueue();
      // A link followed while saving has already decided where to go.
      if (latest.current !== current) return;
      const after = nextToAnnotate(recordings, current);
      if (after) await open(after);
      else setShowQueue(true);
    } finally {
      if (handOvers.current === mine) setHandingOver(false);
    }
  };
  const openQueue = () => {
    setShowQueue(true);
    void refreshQueue();
  };

  return (
    <>
      <Workspace
        key={current}
        recording={opened.recording}
        annotation={opened.annotation}
        canMark={canMark}
        blocked={showQueue || handingOver}
        queueBar={
          <QueueBar
            position={queue.recordings.findIndex((r) => r.id === current) + 1}
            total={queue.recordings.length}
            next={next === null ? 'none' : warm?.id === next ? 'ready' : 'loading'}
            onOpenQueue={openQueue}
          />
        }
        onDecision={(decision) => void handOver(decision)}
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
      {warm?.id === next && <video hidden src={warm.videoUrl} preload="auto" muted />}
    </>
  );
}
