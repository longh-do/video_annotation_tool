/**
 * The annotation screen for one recording: the reference video with the secondary cameras, the
 * state and save chips, the timeline, and the key legend. The keyboard does everything; every key
 * also has a button.
 */
import { useEffect, useEffectEvent, useMemo, useState, useSyncExternalStore } from 'react';
import type { Session } from '../core/api-types.ts';
import { createCommands } from './commands.ts';
import { CameraView } from './components/CameraView.tsx';
import { HelpOverlay, KeyLegend } from './components/KeyLegend.tsx';
import { Overview } from './components/Overview.tsx';
import { Readout } from './components/Readout.tsx';
import { SaveChip } from './components/SaveChip.tsx';
import { type EditorAction, type EditorState, editorReducer } from './editor.ts';
import { type Command, installKeymap, type KeyHandler } from './keymap.ts';
import { placeFromHash } from './location.ts';
import { fromSaved, toSavePayload } from './persistence.ts';
import { DEFAULT_SPEED, Player, SKIM_SPEED } from './player/player.ts';
import { usePlayer } from './player/use-player.ts';
import type { LoadedRecording } from './recording.ts';
import { Saver } from './saver.ts';
import { readResumeFrame, readSetting, writeResumeFrame, writeSetting } from './settings.ts';
import { Store } from './store.ts';

interface WorkspaceProps {
  readonly recording: LoadedRecording;
  readonly session: Session;
  /** False outside Chrome/Edge: the video can be watched, not marked. */
  readonly canMark: boolean;
}

export function Workspace({ recording, session, canMark }: WorkspaceProps) {
  const { info, frames: cameraFrames } = recording;
  const camera = info.cameras[0]!;
  const frames = cameraFrames[0]!;

  const [restored] = useState(() => fromSaved(recording.saved, frames));
  const [editor] = useState(
    () => new Store<EditorState, EditorAction>(editorReducer, restored.editor),
  );
  const [saver] = useState(() => new Saver(info.id, restored.revision, null));
  const state = useSyncExternalStore(editor.subscribe, editor.getState);
  const saveStatus = useSyncExternalStore(saver.subscribe, () => saver.status);

  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const speedLabel = usePlayer(player, (s) => (s.skimming ? `${SKIM_SPEED}× skim` : `${s.speed}×`));
  const seekFailed = usePlayer(player, (s) => s.seekFailed);
  const [showHelp, setShowHelp] = useState(false);
  const [sound, setSound] = useState(() => readSetting('sound', true));

  useEffect(() => {
    if (!video) return;
    const created = new Player(video, frames, readSetting('speed', DEFAULT_SPEED));
    setPlayer(created);
    return () => created.dispose();
  }, [video, frames]);

  // Open at the frame a link names, else where this recording was left. An applied link is
  // trimmed from the URL, so a reload reopens where the annotator was, not at the old link.
  useEffect(() => {
    if (!player) return;
    const goToLinkedFrame = () => {
      const place = placeFromHash();
      if (place.recordingId !== info.id || place.frame === null) return false;
      player.seek(place.frame);
      history.replaceState(null, '', `#${encodeURIComponent(info.id)}`);
      return true;
    };
    if (!goToLinkedFrame()) {
      const resume = readResumeFrame(info.id) ?? restored.resumeFrame;
      if (resume > 0) player.seek(resume);
    }
    window.addEventListener('hashchange', goToLinkedFrame);
    return () => window.removeEventListener('hashchange', goToLinkedFrame);
  }, [player, restored, info.id]);

  // Remember the place whenever the video stops, to reopen there.
  useEffect(() => {
    if (!player) return;
    return player.subscribe(() => {
      if (!player.snapshot.playing && player.frame >= 0) writeResumeFrame(info.id, player.frame);
    });
  }, [player, info.id]);

  const payload = useEffectEvent(() =>
    toSavePayload(
      editor.getState(),
      { recordingId: info.id, referenceVideo: camera.video, frames },
      {
        resumeFrame: Math.max(player?.frame ?? 0, 0),
        playbackRate: player?.snapshot.speed ?? DEFAULT_SPEED,
        activeMs: 0,
        wallMs: 0,
      },
    ),
  );

  // Save each change to the annotation (not to the selection), never mid-drag.
  useEffect(() => {
    let last = editor.getState();
    return editor.subscribe(() => {
      const current = editor.getState();
      if (current.history.gestureBase !== null) return;
      if (current.history.present === last.history.present && current.outcome === last.outcome)
        return;
      last = current;
      saver.save(payload());
    });
  }, [editor, saver]);

  // Send what is pending when the page is hidden, closed or left, and warn before closing
  // with unsaved work.
  useEffect(() => {
    const flush = () => void saver.flush(true);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (saver.dirty) event.preventDefault();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', onBeforeUnload);
      flush();
      saver.dispose();
    };
  }, [saver]);

  // Closing the key list hands the keyboard back to the shortcuts.
  useEffect(() => {
    if (!showHelp && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, [showHelp]);

  // Editing stops once saving has: anything typed after a conflict would be lost.
  const canEdit = useEffectEvent(
    () => canMark && recording.seekable && !seekFailed && !saver.stopped && !showHelp,
  );
  const soundOn = useEffectEvent(() => sound);
  const commands = useMemo(
    () =>
      player &&
      createCommands({
        player,
        editor,
        canEdit,
        sound: soundOn,
        setSpeed: (speed) => {
          player.setSpeed(speed);
          writeSetting('speed', speed);
        },
        toggleHelp: () => setShowHelp((shown) => !shown),
        submit: () => {},
        noTask: () => {},
        needsReview: () => {},
        playAround: () => {},
      }),
    [player, editor],
  );
  // While the key list is open, only H (to close it) reaches the commands.
  useKeymap(commands, (command) => !showHelp || command === 'help');

  const run = (command: Command) => {
    const handler = commands?.[command];
    if (typeof handler === 'function') handler();
  };
  const toggleSound = () => {
    setSound(!sound);
    writeSetting('sound', !sound);
  };

  return (
    <>
      <div className="workspace" inert={showHelp}>
        <header className="topbar">
          <span className="recording-id">{info.id}</span>
          <span className={`status status-${state.outcome.status}`}>
            {state.outcome.status.replace('_', ' ')}
          </span>
          <span className="session">
            {session.annotatorId}
            {session.guideline ? ` · ${session.guideline.title}` : ''}
          </span>
          <SaveChip status={saveStatus} />
        </header>

        <main className="stage">
          <div className="primary">
            <video
              ref={setVideo}
              src={camera.videoUrl}
              preload="auto"
              muted
              playsInline
              data-camera="head"
            />
            {!canMark && (
              <p className="banner">
                Annotation needs Chrome or Edge. You can watch here, not mark.
              </p>
            )}
            {!recording.seekable && (
              <p className="banner">
                The media server ignores byte ranges, so seeking can't work. Start it with pnpm dev.
              </p>
            )}
            {seekFailed && (
              <p className="banner">
                Couldn't confirm which frame is on screen. Marking is off until a seek succeeds.
              </p>
            )}
            {saver.stopped && (
              <p className="banner">
                {saveStatus.kind === 'conflict'
                  ? 'This recording was saved from another tab. Editing is off here so nothing is lost.'
                  : 'The server refused this annotation, so editing is off.'}{' '}
                <button type="button" onClick={() => location.reload()}>
                  Reload
                </button>
              </p>
            )}
          </div>
          <aside className="side">
            {info.cameras.slice(1).map((secondary, i) => (
              <CameraView
                key={secondary.name}
                camera={secondary}
                frames={cameraFrames[i + 1]!}
                player={player}
                referenceFrames={frames}
              />
            ))}
          </aside>
        </main>

        <section className="controls">
          <div className="readout">
            <Readout player={player} timeline={state.history.present} frames={frames} />
            <span className="speed">{speedLabel}</span>
            <button
              type="button"
              className="sound"
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleSound}
            >
              {sound ? 'Sound on' : 'Sound off'}
            </button>
          </div>
          <Overview
            player={player}
            timeline={state.history.present}
            frames={frames}
            selected={state.selected}
            onSeek={(target) => player?.seek(target)}
          />
        </section>

        <KeyLegend onRun={run} />
      </div>
      {showHelp && <HelpOverlay onRun={run} onClose={() => setShowHelp(false)} />}
    </>
  );
}

/** Installs the keymap once; each key press asks for the current handlers and filter. */
function useKeymap(
  handlers: Record<Command, KeyHandler> | null,
  enabled: (command: Command) => boolean,
) {
  const handlerFor = useEffectEvent((command: Command) => handlers?.[command] ?? (() => {}));
  const isEnabled = useEffectEvent((command: Command) => handlers !== null && enabled(command));
  useEffect(() => installKeymap(handlerFor, isEnabled), []);
}
