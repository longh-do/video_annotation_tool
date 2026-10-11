/**
 * The annotation screen for one recording: the reference video beside the secondary cameras and
 * a side panel (kept intervals, guideline); under it the state chip, the check pass and the two
 * timelines; the key legend at the bottom. The keyboard does everything; every key also has a
 * button. Submitting, "no useful task" and "needs review" save an outcome and hand over to the
 * queue.
 */
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Session } from '../core/api-types.ts';
import { boundariesToCheck } from '../core/check.ts';
import { keepSegments, stateAt } from '../core/timeline.ts';
import type { AnnotationSession } from './annotation-session.ts';
import { type CommandContext, createCommands, createPointerActions } from './commands.ts';
import { CameraView } from './components/CameraView.tsx';
import { CheckPanel } from './components/CheckPanel.tsx';
import { ConfirmBar } from './components/ConfirmBar.tsx';
import { DetailTimeline } from './components/DetailTimeline.tsx';
import { GuidelinePanel } from './components/GuidelinePanel.tsx';
import { IntervalList } from './components/IntervalList.tsx';
import { HelpOverlay, KeyLegend } from './components/KeyLegend.tsx';
import { Overview } from './components/Overview.tsx';
import { Readout } from './components/Readout.tsx';
import { ReviewDialog } from './components/ReviewDialog.tsx';
import { SaveChip } from './components/SaveChip.tsx';
import { SidePanel } from './components/SidePanel.tsx';
import type { ToastMessage } from './components/Toast.tsx';
import type { EditorAction } from './editor.ts';
import { type Command, installKeymap, type KeyHandler } from './keymap.ts';
import { placeFromHash } from './location.ts';
import { FrameGrabber } from './player/frame-grabber.ts';
import { AROUND_SPEED, DEFAULT_SPEED, Player, SKIM_SPEED } from './player/player.ts';
import { usePlayer } from './player/use-player.ts';
import type { LoadedRecording } from './recording.ts';
import { readResumeFrame, readSetting, writeResumeFrame, writeSetting } from './settings.ts';

/** An outcome to save, and what to say once it is saved. */
export interface Outcome {
  readonly action: EditorAction;
  readonly text: string;
  /** The toast offers Undo (else Back): only when undo restores what the outcome removed. */
  readonly undo: boolean;
}

interface WorkspaceProps {
  readonly recording: LoadedRecording;
  /** The recording's annotation; it lives on after this screen closes. */
  readonly annotation: AnnotationSession;
  readonly session: Session;
  /** False outside Chrome/Edge: the video can be watched, not marked. */
  readonly canMark: boolean;
  /** Where the recording is in the queue, for the top bar. */
  readonly queueBar: ReactNode;
  /** Keys and edits are off: the queue is open, or an outcome is being handed over. */
  readonly blocked: boolean;
  /** Saves the outcome and moves the queue on; keys stay off meanwhile. */
  readonly onOutcome: (outcome: Outcome) => void;
  readonly onToast: (message: ToastMessage) => void;
}

type Question = 'keep-to-end' | 'no-task' | 'review';

export function Workspace(props: WorkspaceProps) {
  const { recording, annotation, session, canMark, blocked, onOutcome, onToast } = props;
  const { info, frames: cameraFrames } = recording;
  const camera = info.cameras[0]!;
  const frames = cameraFrames[0]!;
  const { editor, saver } = annotation;
  const state = useSyncExternalStore(editor.subscribe, editor.getState);
  const saveStatus = useSyncExternalStore(saver.subscribe, () => saver.status);

  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [grabber, setGrabber] = useState<FrameGrabber | null>(null);
  const speedLabel = usePlayer(player, (s) =>
    s.around ? `${AROUND_SPEED}× replay` : s.skimming ? `${SKIM_SPEED}× skim` : `${s.speed}×`,
  );
  const seekFailed = usePlayer(player, (s) => s.seekFailed);
  const [showHelp, setShowHelp] = useState(false);
  /** An outcome waiting for a confirmation or a reason. */
  const [asking, setAsking] = useState<Question | null>(null);
  const [sound, setSound] = useState(() => readSetting('sound', true));

  useEffect(() => {
    if (!video) return;
    const created = new Player(video, frames, readSetting('speed', DEFAULT_SPEED));
    setPlayer(created);
    return () => created.dispose();
  }, [video, frames]);

  useEffect(() => {
    const created = new FrameGrabber(camera.videoUrl, frames);
    setGrabber(created);
    return () => created.dispose();
  }, [camera.videoUrl, frames]);

  // Open at the frame a link names, else where this recording was left. An applied link is
  // trimmed from the URL, so a reload reopens where the annotator was, not at the old link. The
  // choice is made once: the effect can run again (a new player) after the link is gone.
  const opening = useRef<number | null>(null);
  useEffect(() => {
    if (!player) return;
    const linkedFrame = () => {
      const place = placeFromHash();
      if (place.recordingId !== info.id || place.frame === null) return null;
      history.replaceState(null, '', `#${encodeURIComponent(info.id)}`);
      return place.frame;
    };
    opening.current ??= linkedFrame() ?? readResumeFrame(info.id) ?? annotation.place.frame;
    if (opening.current > 0) player.seek(opening.current);
    const followLink = () => {
      const frame = linkedFrame();
      if (frame !== null) player.seek(frame);
    };
    window.addEventListener('hashchange', followLink);
    return () => window.removeEventListener('hashchange', followLink);
  }, [player, annotation, info.id]);

  // The annotation saves where the annotator is (to reopen there on another computer) and counts
  // active time while this screen is open: playing, or keys and pointer in the last 30 s.
  useEffect(() => {
    if (!player) return;
    const detach = annotation.attach(() => ({
      frame: player.frame,
      playbackRate: player.snapshot.speed,
    }));
    const active = () => annotation.noteInput();
    window.addEventListener('keydown', active, { capture: true });
    window.addEventListener('pointerdown', active, { capture: true });
    return () => {
      window.removeEventListener('keydown', active, { capture: true });
      window.removeEventListener('pointerdown', active, { capture: true });
      detach();
    };
  }, [player, annotation]);

  // Telemetry: when the first frame shows, and each play, pause and change of speed.
  useEffect(() => {
    if (!player) return;
    const openedAt = performance.now();
    let ready = false;
    let playing = false;
    let rate = 0;
    return player.subscribe(() => {
      const s = player.snapshot;
      if (!ready && s.frame >= 0) {
        ready = true;
        annotation.log('media_ready', { load_ms: Math.round(performance.now() - openedAt) });
      }
      const now = s.around ? AROUND_SPEED : s.skimming ? SKIM_SPEED : s.speed;
      if (s.playing === playing && (now === rate || !s.playing)) return;
      const action = s.playing === playing ? 'rate' : s.playing ? 'play' : 'pause';
      playing = s.playing;
      rate = now;
      annotation.notePlayback(playing, rate, action);
    });
  }, [player, annotation]);

  useEffect(() => {
    document.title = `${info.id} · Keep/cut annotator`;
  }, [info.id]);

  // Remember the place whenever the video stops, to reopen there.
  useEffect(() => {
    if (!player) return;
    return player.subscribe(() => {
      if (!player.snapshot.playing && player.frame >= 0) writeResumeFrame(info.id, player.frame);
    });
  }, [player, info.id]);

  // Closing the key list hands the keyboard back to the shortcuts.
  useEffect(() => {
    if (!showHelp && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, [showHelp]);

  // Editing stops once saving has: anything typed after a conflict would be lost. Keys don't
  // edit during a drag either: the drag is one undo step.
  const editable =
    canMark &&
    recording.seekable &&
    !seekFailed &&
    !saver.stopped &&
    !showHelp &&
    !blocked &&
    asking === null;

  const finish = (outcome: Outcome) => {
    setAsking(null);
    onOutcome(outcome);
  };
  const submit = {
    action: { type: 'submit' },
    text: `Submitted ${info.id}.`,
    undo: false,
  } as const;

  // Keys and the mouse share one context. The keymap asks for the handlers at each key press,
  // so the values read here are those of the latest render.
  const context: CommandContext | null = player && {
    player,
    editor,
    canEdit: () => editable && editor.getState().history.gestureBase === null,
    sound: () => sound,
    setSpeed: (speed) => {
      player.setSpeed(speed);
      writeSetting('speed', speed);
    },
    toggleHelp: () => setShowHelp((shown) => !shown),
    // ⌘↵: rough marks are checked first; nothing kept is "no useful task", which N confirms; a
    // keep that runs to the end is confirmed too.
    submit: () => {
      const timeline = editor.getState().history.present;
      const rough = boundariesToCheck(timeline);
      const first = timeline.boundaries[rough[0] ?? -1];
      if (first) {
        pointer?.goTo(first.frame);
        onToast({
          text: `${rough.length} rough ${rough.length === 1 ? 'mark' : 'marks'} to check before submitting: Enter accepts each one.`,
        });
      } else if (keepSegments(timeline).length === 0) {
        setAsking('no-task');
      } else if (stateAt(timeline, timeline.frameCount - 1) === 'keep') {
        setAsking('keep-to-end');
      } else {
        finish(submit);
      }
    },
    noTask: () => setAsking('no-task'),
    needsReview: () => setAsking('review'),
  };
  const commands = context && createCommands(context);
  const pointer = context && createPointerActions(context);
  // While the key list is open, only H (to close it) reaches the commands; while the queue or a
  // question is up, none do.
  useKeymap(
    commands,
    (command) => !blocked && asking === null && (!showHelp || command === 'help'),
  );

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
      <div className="workspace" inert={showHelp || blocked || asking === 'review'}>
        <header className="topbar">
          <span className="recording-id">{info.id}</span>
          <span className={`status status-${state.outcome.status}`}>
            {state.outcome.status.replace('_', ' ')}
          </span>
          <span className="session">
            {session.annotatorId}
            {session.guideline ? ` · ${session.guideline.title}` : ''}
          </span>
          {props.queueBar}
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
              aria-label={`${camera.label} camera, the one annotated`}
            />
            {!canMark && (
              <p className="banner" role="alert">
                Annotation needs Chrome or Edge. You can watch here, not mark.
              </p>
            )}
            {!recording.seekable && (
              <p className="banner" role="alert">
                The media server ignores byte ranges, so seeking can't work. Start it with pnpm dev.
              </p>
            )}
            {seekFailed && (
              <p className="banner" role="alert">
                Couldn't confirm which frame is on screen. Marking is off until a seek succeeds.
              </p>
            )}
            {saver.stopped && (
              <p className="banner" role="alert">
                {saveStatus.kind === 'conflict'
                  ? 'This recording was saved from another tab. Editing is off here so nothing is lost.'
                  : 'The server refused this annotation, so editing is off.'}{' '}
                <button type="button" onClick={() => location.reload()}>
                  Reload
                </button>
              </p>
            )}
            {/* A question waits, without listening, while the queue is open. */}
            {asking === 'keep-to-end' && !blocked && (
              <ConfirmBar
                message="The last kept interval runs to the end of the video. Submit anyway?"
                confirmLabel="↵"
                confirms={(event) => event.key === 'Enter'}
                onConfirm={() => finish(submit)}
                onCancel={() => setAsking(null)}
              />
            )}
            {asking === 'no-task' && !blocked && (
              <ConfirmBar
                message="No useful task: cut the whole recording and submit it?"
                confirmLabel="↵"
                onConfirm={() =>
                  finish({
                    action: { type: 'no-task' },
                    text: `${info.id}: no useful task.`,
                    // The toast can undo it, if there was something to cut.
                    undo: editor.getState().history.present.boundaries.length > 0,
                  })
                }
                onCancel={() => setAsking(null)}
              />
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
          <CheckPanel
            player={player}
            grabber={grabber}
            timeline={state.history.present}
            frames={frames}
            selected={state.selected}
            anchor={state.anchor}
            onVisit={(frame) => pointer?.goTo(frame)}
            onPick={(frame) => pointer?.pick(frame)}
          />
          <Overview
            player={player}
            timeline={state.history.present}
            frames={frames}
            selected={state.selected}
            thumbnails={info.thumbnails}
            onSeek={(target) => player?.seek(target)}
          />
          <DetailTimeline
            player={player}
            timeline={state.history.present}
            frames={frames}
            selected={state.selected}
            onSeek={(target) => player?.seek(target)}
            onDragStart={(index) => pointer?.dragStart(index)}
            onDrag={(index, frame) => pointer?.drag(index, frame)}
            onDragEnd={() => pointer?.dragEnd()}
            onDragCancel={() => pointer?.dragCancel()}
          />
        </section>

        <SidePanel
          tabs={{
            Intervals: (
              <IntervalList
                player={player}
                timeline={state.history.present}
                frames={frames}
                onSelect={(frame) => pointer?.goTo(frame)}
              />
            ),
            ...(session.guideline && {
              Guideline: <GuidelinePanel version={session.guideline.version} />,
            }),
          }}
        />

        <KeyLegend onRun={run} />
      </div>
      {showHelp && <HelpOverlay onRun={run} onClose={() => setShowHelp(false)} />}
      {asking === 'review' && !blocked && (
        <ReviewDialog
          onSubmit={(reason, notes) =>
            finish({
              action: { type: 'needs-review', reason, notes },
              text: `Sent ${info.id} to review.`,
              undo: false,
            })
          }
          onCancel={() => setAsking(null)}
        />
      )}
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
