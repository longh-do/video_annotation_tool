/**
 * The annotation screen for one recording: the head camera large beside the other cameras, and a
 * side panel (kept intervals, the task, how to use the tool); under the video the check pass, the
 * transport row and the timeline. The keyboard does everything, and so does the mouse: every key
 * has a button or a menu entry, and ⌘K lists them all. Submitting, "no useful task" and "needs
 * review" save an outcome and hand over to the queue.
 */
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Status } from '../core/annotation.ts';
import { boundariesToCheck } from '../core/check.ts';
import { keepSegments, type Segment, stateAt } from '../core/timeline.ts';
import type { AnnotationSession } from './annotation-session.ts';
import { type CommandContext, createCommands, createPointerActions } from './commands.ts';
import { CameraTile, CameraView } from './components/CameraView.tsx';
import { CheckPanel } from './components/CheckPanel.tsx';
import { CommandMenu } from './components/CommandMenu.tsx';
import { type BarAction, ConfirmBar } from './components/ConfirmBar.tsx';
import { GuidePanel } from './components/GuidePanel.tsx';
import { IntervalList } from './components/IntervalList.tsx';
import { ChevronIcon, RedoIcon, UndoIcon } from './components/icons.tsx';
import { Menu, type MenuAnchor, type MenuItem } from './components/Menu.tsx';
import { ReviewDialog } from './components/ReviewDialog.tsx';
import { SaveChip } from './components/SaveChip.tsx';
import { clampPanelWidth, PANEL_WIDTH, SidePanel } from './components/SidePanel.tsx';
import { TaskPanel } from './components/TaskPanel.tsx';
import { TimelineBar } from './components/TimelineBar.tsx';
import type { ToastMessage } from './components/Toast.tsx';
import { Transport } from './components/Transport.tsx';
import { type EditorAction, selectedInterval } from './editor.ts';
import { clock } from './format.ts';
import { type Command, installKeymap, type KeyHandler, keysOf, matches } from './keymap.ts';
import { placeFromHash } from './location.ts';
import { mosaic } from './mosaic.ts';
import { DEFAULT_SPEED, Player, SKIM_SPEED } from './player/player.ts';
import { usePlayer } from './player/use-player.ts';
import type { LoadedRecording } from './recording.ts';
import { readResumeFrame, readSetting, writeResumeFrame, writeSetting } from './settings.ts';
import { TimelineView, timelineEndUs, ZOOM_STEP } from './timeline-view.ts';

/** The annotator's decision about a recording: the outcome to save, and what to say after. */
export interface Decision {
  readonly action: EditorAction;
  readonly text: string;
  /** The toast offers Undo (else Back): only when undo restores what the outcome removed. */
  readonly undo: boolean;
}

interface WorkspaceProps {
  readonly recording: LoadedRecording;
  /** The recording's annotation; it lives on after this screen closes. */
  readonly annotation: AnnotationSession;
  /** False outside Chrome/Edge: the video can be watched, not marked. */
  readonly canMark: boolean;
  /** Where the recording is in the queue, for the top bar. */
  readonly queueBar: ReactNode;
  /** Keys and edits are off: the queue is open, or an outcome is being handed over. */
  readonly blocked: boolean;
  /** Saves the outcome and moves the queue on; keys stay off meanwhile. */
  readonly onDecision: (decision: Decision) => void;
  readonly onToast: (message: ToastMessage) => void;
}

type Question = 'submit' | 'no-task' | 'review';

const STATUS: Record<Status, string> = {
  not_reviewed: 'Not submitted',
  complete: 'Submitted',
  needs_review: 'Needs review',
};

/** Space between the camera tiles, in CSS pixels. */
const TILE_GAP = 8;
/** A second ⌘↵ this soon after the first is not an answer to the question it raised. */
const ARM_MS = 500;

const plainEnter = (event: KeyboardEvent) =>
  event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey;
const submitKey = (event: KeyboardEvent) =>
  matches({ code: 'Enter', mod: true }, event) ||
  matches({ code: 'NumpadEnter', mod: true }, event);

export function Workspace(props: WorkspaceProps) {
  const { recording, annotation, canMark, blocked, onDecision, onToast } = props;
  const { info, frames: cameraFrames } = recording;
  const camera = info.cameras[0]!;
  const frames = cameraFrames[0]!;
  const { editor, saver } = annotation;
  const state = useSyncExternalStore(editor.subscribe, editor.getState);
  const saveStatus = useSyncExternalStore(saver.subscribe, () => saver.status);

  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [view] = useState(() => new TimelineView(timelineEndUs(frames)));
  const seekFailed = usePlayer(player, (s) => s.seekFailed);
  const [showCommands, setShowCommands] = useState(false);
  /** An outcome waiting for a confirmation or a reason. */
  const [asking, setAsking] = useState<Question | null>(null);
  const [menu, setMenu] = useState<{
    readonly label: string;
    readonly items: readonly (MenuItem | null)[];
    readonly at: MenuAnchor;
    /** The button that opened it, if a button did: pressing it again closes the menu. */
    readonly owner?: HTMLElement | null;
  } | null>(null);
  const [sound, setSound] = useState(() => readSetting('sound', true));
  const [panelWidth, setPanelWidth] = useState(() =>
    clampPanelWidth(readSetting('panelWidth', PANEL_WIDTH.normal)),
  );
  /** The camera shown big; the annotator's choice sticks between recordings. */
  const [large, setLarge] = useState(() => readSetting('mainCamera', camera.label));
  const largeIndex = Math.max(
    info.cameras.findIndex((c) => c.label === large),
    0,
  );
  const largeCamera = info.cameras[largeIndex]!;
  /** Big view first, then the others in their order. */
  const areaOf = (index: number) => {
    if (index === largeIndex) return 'main';
    const rank = info.cameras.filter((_, i) => i !== largeIndex && i < index).length;
    return `side${rank + 1}`;
  };
  const stage = useStageSize();
  const sides = info.cameras.length - 1;
  const ratioOf = (c: { width: number; height: number }) => c.width / c.height;
  const tiles = mosaic(
    stage.width,
    stage.height,
    {
      main: ratioOf(largeCamera),
      side: Math.max(...info.cameras.filter((_, i) => i !== largeIndex).map(ratioOf), 1),
    },
    sides,
    TILE_GAP,
  );
  const showLarge = (label: string) => {
    setLarge(label);
    writeSetting('mainCamera', label);
  };
  const outcomes = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!video) return;
    const created = new Player(video, frames, readSetting('speed', DEFAULT_SPEED));
    setPlayer(created);
    return () => created.dispose();
  }, [video, frames]);

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
      const now = s.skimming ? SKIM_SPEED : s.speed;
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

  // Editing stops once saving has: anything typed after a conflict would be lost. Keys don't
  // edit during a drag either: the drag is one undo step.
  const editable =
    canMark && recording.seekable && !seekFailed && !saver.stopped && !blocked && asking === null;

  const present = state.history.present;
  const finish = (decision: Decision) => {
    setAsking(null);
    onDecision(decision);
  };
  const submit = {
    action: { type: 'submit' },
    text: `Submitted ${info.id}.`,
    undo: false,
  } as const;

  /** The playhead's time when it is in view, else the middle of the view. */
  const zoomAnchor = () => {
    const { startUs, spanUs } = view.view;
    const us = frames.ptsUs[Math.max(player?.frame ?? 0, 0)] ?? 0;
    return us >= startUs && us <= startUs + spanUs ? us : startUs + spanUs / 2;
  };

  // Keys and the mouse share one context. The keymap asks for the handlers at each key press,
  // so the values read here are those of the latest render.
  const context: CommandContext | null = player && {
    player,
    editor,
    canEdit: () => editable && editor.getState().history.gestureBase === null,
    sound: () => sound,
    zoom: (how) => {
      if (how === 'fit') view.fit();
      else view.zoom(how === 'in' ? ZOOM_STEP : 1 / ZOOM_STEP, zoomAnchor());
    },
    toggleHelp: () => setShowCommands((shown) => !shown),
    // ⌘↵: nothing kept is "no useful task", which N confirms; marks still to check and a keep
    // that runs to the end are worth a second look, so they ask first.
    submit: () => {
      const timeline = editor.getState().history.present;
      if (keepSegments(timeline).length === 0) setAsking('no-task');
      else if (boundariesToCheck(timeline).length > 0 || keepsToEnd(timeline)) setAsking('submit');
      else finish(submit);
    },
    noTask: () => setAsking('no-task'),
    needsReview: () => setAsking('review'),
  };
  const commands = context && createCommands(context);
  const pointer = context && createPointerActions(context);
  // While the command menu is open, only its own keys reach the commands; while the queue or a
  // question is up, none do.
  useKeymap(
    commands,
    (command) => !blocked && asking === null && (!showCommands || command === 'help'),
  );

  const run = (command: Command) => {
    const handler = commands?.[command];
    if (typeof handler === 'function') handler();
  };
  // A message's button may be clicked several renders later: it runs the commands of the latest.
  const latestRun = useRef(run);
  useEffect(() => {
    latestRun.current = run;
  });
  const toggleSound = () => {
    setSound(!sound);
    writeSetting('sound', !sound);
  };
  const setSpeed = (speed: number) => {
    player?.setSpeed(speed);
    writeSetting('speed', speed);
  };

  /** Runs a mouse edit; true if it changed the annotation. */
  const changed = (edit: () => void) => {
    const before = editor.getState().history.present;
    edit();
    return editor.getState().history.present !== before;
  };
  const time = (frame: number) => clock((frames.ptsUs[frame] ?? 0) / 1e6);
  /** Says what a click deleted, with an Undo that goes away once it would undo anything else. */
  const deleted = (text: string) => {
    const after = editor.getState().history.present;
    onToast({
      text,
      action: { label: 'Undo', keys: keysOf('undo'), run: () => latestRun.current('undo') },
      closeWhen: (close) =>
        editor.subscribe(() => {
          if (editor.getState().history.present !== after) close();
        }),
    });
  };
  const deleteBoundary = (index: number) => {
    const frame = present.boundaries[index]?.frame;
    if (frame !== undefined && changed(() => pointer?.deleteBoundary(index))) {
      deleted(`Deleted the boundary at ${time(frame)}`);
    }
  };
  const deleteInterval = (interval: Segment) => {
    if (changed(() => pointer?.setRange(interval.start, interval.end, 'cut'))) {
      const end = interval.end >= present.frameCount ? 'the end' : time(interval.end);
      deleted(`Deleted the interval ${time(interval.start)}–${end}`);
    }
  };
  /** Right-click on the timeline or the list: what can be done with that stretch. */
  const openMenu = (segment: Segment, at: MenuAnchor) => {
    if (segment.state === 'cut') {
      setMenu({
        label: 'Cut stretch',
        at,
        items: [
          {
            label: 'Keep this part',
            disabled: !editable,
            run: () => pointer?.setRange(segment.start, segment.end, 'keep'),
          },
        ],
      });
      return;
    }
    pointer?.selectInterval(segment.start, null);
    const kept = keepSegments(present);
    const i = kept.findIndex((s) => s.start === segment.start);
    const previous = kept[i - 1];
    const next = kept[i + 1];
    setMenu({
      label: 'Interval',
      at,
      items: [
        {
          label: 'Merge with the previous interval',
          disabled: !editable || !previous,
          run: () => previous && pointer?.setRange(previous.end, segment.start, 'keep'),
        },
        {
          label: 'Merge with the next interval',
          disabled: !editable || !next,
          run: () => next && pointer?.setRange(segment.end, next.start, 'keep'),
        },
        null,
        {
          label: 'Delete interval',
          danger: true,
          keys: keysOf('deleteSelected').split(' or ')[0],
          disabled: !editable,
          run: () => deleteInterval(segment),
        },
      ],
    });
  };

  const unchecked = boundariesToCheck(present);
  const reasons = submitReasons(unchecked.length, keepsToEnd(present));
  const submitActions: BarAction[] = [
    ...(unchecked.length > 0
      ? [
          {
            label: 'Check them',
            keyLabel: keysOf('accept'),
            matches: plainEnter,
            run: () => {
              setAsking(null);
              pointer?.goTo(present.boundaries[unchecked[0]!]!.frame);
            },
          },
        ]
      : []),
    {
      label: 'Submit anyway',
      keyLabel: keysOf('submit'),
      matches: submitKey,
      run: () => finish(submit),
    },
  ];
  const status = state.outcome.status;

  return (
    <>
      <div
        className="workspace"
        style={{ gridTemplateColumns: `minmax(0, 1fr) ${panelWidth}px` }}
        inert={showCommands || blocked || asking === 'review'}
      >
        <header className="topbar">
          {props.queueBar}
          {/* What to do first, then where things stand; the id only to quote, e.g. in a report. */}
          <span
            className={`task-name${info.task ? '' : ' task-none'}`}
            title="The task to annotate: the Task tab says what to keep"
          >
            {info.task ? info.task.title : 'No task guide'}
          </span>
          <span className="recording-length" title="Length of the recording">
            {clock(info.durationS).replace(/\.\d$/, '')}
          </span>
          <span className={`status-pill status-${status}`}>{STATUS[status]}</span>
          <button
            type="button"
            className="recording-id"
            title="Recording ID: click to copy it, e.g. to report a problem"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() =>
              navigator.clipboard.writeText(info.id).then(
                () => onToast({ text: `Copied the recording ID ${info.id}` }),
                () => onToast({ text: `Couldn't copy the recording ID: ${info.id}` }),
              )
            }
          >
            {info.id}
          </button>
          <SaveChip status={saveStatus} />
          <div className="topbar-actions">
            <button
              type="button"
              className="icon-button command-button"
              title={`Show command menu… ${keysOf('help').split(' or ')[0]}`}
              aria-label="Command menu"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setShowCommands(true)}
            >
              ⌘
            </button>
            <button
              type="button"
              className="icon-button"
              title={`Undo (${keysOf('undo')})`}
              aria-label="Undo"
              disabled={!editable || state.history.past.length === 0}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => run('undo')}
            >
              <UndoIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              title={`Redo (${keysOf('redo')})`}
              aria-label="Redo"
              disabled={!editable || state.history.future.length === 0}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => run('redo')}
            >
              <RedoIcon />
            </button>
            <span className="submit-group">
              <button
                type="button"
                className="primary"
                title={`Submit and open the next recording (${keysOf('submit')})`}
                disabled={!editable}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => run('submit')}
              >
                Submit
              </button>
              <button
                ref={outcomes}
                type="button"
                className="primary submit-more"
                title="Other outcomes"
                aria-label="Other outcomes"
                aria-haspopup="menu"
                disabled={!editable}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const owner = outcomes.current;
                  if (!owner || menu?.owner === owner) {
                    setMenu(null);
                    return;
                  }
                  setMenu({
                    label: 'Outcome',
                    at: owner.getBoundingClientRect(),
                    owner,
                    items: (['submit', 'noTask', 'needsReview'] as const).map((command) => ({
                      label: OUTCOME_LABELS[command],
                      keys: keysOf(command),
                      run: () => run(command),
                    })),
                  });
                }}
              >
                <ChevronIcon />
              </button>
            </span>
          </div>
        </header>

        <main className="stage" ref={stage.ref}>
          <div
            className="mosaic"
            style={{
              gridTemplateColumns:
                sides > 0 ? `${tiles.mainWidth}px ${tiles.sideWidth}px` : `${tiles.mainWidth}px`,
              gridTemplateRows: `repeat(${Math.max(sides, 1)}, 1fr)`,
              gridTemplateAreas: Array.from({ length: Math.max(sides, 1) }, (_, i) =>
                sides > 0 ? `"main side${i + 1}"` : '"main"',
              ).join(' '),
              height: tiles.mainHeight,
              gap: TILE_GAP,
            }}
          >
            {/* The head camera counts the frames that marks are saved on, wherever it is shown. */}
            <CameraTile
              label={camera.label}
              area={areaOf(0)}
              onShowLarge={() => showLarge(camera.label)}
            >
              <video
                ref={setVideo}
                src={camera.videoUrl}
                preload="auto"
                muted
                playsInline
                data-camera="head"
                aria-label={`${camera.label} camera, the one annotated`}
              />
            </CameraTile>
            {info.cameras.slice(1).map((secondary, i) => (
              <CameraView
                key={secondary.name}
                camera={secondary}
                frames={cameraFrames[i + 1]!}
                player={player}
                referenceFrames={frames}
                area={areaOf(i + 1)}
                onShowLarge={() => showLarge(secondary.label)}
              />
            ))}
            <div className="stage-overlay">
              {!canMark && (
                <p className="banner" role="alert">
                  Annotation needs Chrome or Edge. You can watch here, not mark.
                </p>
              )}
              {!recording.seekable && (
                <p className="banner" role="alert">
                  The media server ignores byte ranges, so seeking can't work. Start it with pnpm
                  dev.
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
              {/* A question waits, without listening, while the queue or the command menu is open. */}
              {asking === 'submit' && !blocked && !showCommands && (
                <ConfirmBar
                  title="Submit anyway?"
                  details={reasons}
                  actions={submitActions}
                  armMs={ARM_MS}
                  onCancel={() => setAsking(null)}
                />
              )}
              {asking === 'no-task' && !blocked && !showCommands && (
                <ConfirmBar
                  title="No useful task?"
                  details={['This cuts the whole recording and submits it.']}
                  actions={[
                    {
                      label: 'Cut all and submit',
                      keyLabel: keysOf('accept'),
                      matches: plainEnter,
                      run: () =>
                        finish({
                          action: { type: 'no-task' },
                          text: `${info.id}: no useful task.`,
                          // The toast can undo it, if there was something to cut.
                          undo: editor.getState().history.present.boundaries.length > 0,
                        }),
                    },
                  ]}
                  onCancel={() => setAsking(null)}
                />
              )}
            </div>
          </div>
        </main>

        <section className="controls">
          <CheckPanel
            player={player}
            timeline={present}
            frames={frames}
            selected={state.selected}
            onVisit={(frame) => pointer?.goTo(frame)}
            onRemove={(short) =>
              pointer?.setRange(short.start, short.end, short.state === 'keep' ? 'cut' : 'keep')
            }
            onRun={run}
          />
          <Transport
            player={player}
            timeline={present}
            frames={frames}
            view={view}
            editable={editable}
            sound={sound}
            onToggleSound={toggleSound}
            onSpeed={setSpeed}
            zoomAnchor={zoomAnchor}
            onRun={run}
          />
          <TimelineBar
            player={player}
            view={view}
            timeline={present}
            frames={frames}
            selected={state.selected}
            interval={selectedInterval(state)}
            thumbnails={info.thumbnails}
            editable={editable}
            onSeek={(frame) => player?.seek(frame)}
            onSelectInterval={(start, frame) => pointer?.selectInterval(start, frame)}
            onDragStart={(index) => pointer?.dragStart(index)}
            onDrag={(index, frame) => pointer?.drag(index, frame)}
            onDragEnd={() => pointer?.dragEnd()}
            onDragCancel={() => pointer?.dragCancel()}
            onDeleteBoundary={deleteBoundary}
            onMenu={openMenu}
          />
        </section>

        <SidePanel
          width={panelWidth}
          onResize={(width, done) => {
            setPanelWidth(width);
            if (done) writeSetting('panelWidth', width);
          }}
          tabs={{
            Intervals: (
              <IntervalList
                player={player}
                timeline={present}
                frames={frames}
                selected={state.interval}
                onSelect={(interval) => pointer?.selectInterval(interval.start, interval.start)}
                onMenu={openMenu}
              />
            ),
            Task: <TaskPanel task={info.task} />,
            Guide: <GuidePanel />,
          }}
        />
      </div>
      {menu && (
        <Menu
          label={menu.label}
          items={menu.items}
          at={menu.at}
          owner={menu.owner}
          onClose={() => setMenu(null)}
        />
      )}
      {showCommands && <CommandMenu onRun={run} onClose={() => setShowCommands(false)} />}
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

const OUTCOME_LABELS = {
  submit: 'Submit and open the next recording',
  noTask: 'No useful task…',
  needsReview: 'Needs review…',
} as const;

/** The last frame is kept: the last interval never got its stop. */
function keepsToEnd(timeline: Parameters<typeof stateAt>[0]): boolean {
  return stateAt(timeline, timeline.frameCount - 1) === 'keep';
}

/** What ⌘↵ asks about before submitting, in plain words. */
function submitReasons(unchecked: number, toEnd: boolean): string[] {
  const reasons: string[] = [];
  if (unchecked > 0) {
    const marks = unchecked === 1 ? '1 mark still needs' : `${unchecked} marks still need`;
    reasons.push(`${marks} checking. Marks made while the video plays can be a few frames late.`);
  }
  if (toEnd) {
    reasons.push(
      `The last interval has no stop, so it keeps everything to the end of the video. If the task ended earlier, go back and press Stop (${keysOf('cut')}) where it ends.`,
    );
  }
  return reasons;
}

/** The stage's inner size, kept up to date, for laying out the cameras. */
function useStageSize() {
  const ref = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((was) => (was.width === width && was.height === height ? was : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ...size, ref };
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
