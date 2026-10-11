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
import { boundariesToCheck } from '../core/check.ts';
import { keepSegments, type Segment } from '../core/timeline.ts';
import type { AnnotationSession } from './annotation-session.ts';
import { type CommandContext, createCommands, createPointerActions } from './commands.ts';
import { CameraStage } from './components/CameraStage.tsx';
import { CheckPanel } from './components/CheckPanel.tsx';
import { CommandMenu } from './components/CommandMenu.tsx';
import { GuidePanel } from './components/GuidePanel.tsx';
import { IntervalList } from './components/IntervalList.tsx';
import { Menu, type MenuAnchor, type MenuItem } from './components/Menu.tsx';
import {
  type Decision,
  keepsToEnd,
  OutcomeQuestion,
  submitDecision,
} from './components/OutcomeQuestion.tsx';
import { ReviewDialog } from './components/ReviewDialog.tsx';
import { clampPanelWidth, PANEL_WIDTH, SidePanel } from './components/SidePanel.tsx';
import { TaskPanel } from './components/TaskPanel.tsx';
import { TimelineBar } from './components/TimelineBar.tsx';
import type { ToastMessage } from './components/Toast.tsx';
import { TopBar } from './components/TopBar.tsx';
import { Transport } from './components/Transport.tsx';
import { selectedInterval } from './editor.ts';
import { clock } from './format.ts';
import { stretchMenu } from './interval-menu.ts';
import { type Command, installKeymap, type KeyHandler, keysOf } from './keymap.ts';
import { usePlayer } from './player/use-player.ts';
import type { LoadedRecording } from './recording.ts';
import { readSetting, writeSetting } from './settings.ts';
import { TimelineView, timelineEndUs, ZOOM_STEP } from './timeline-view.ts';
import { useAnnotationPlayer } from './use-annotation-player.ts';

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

/** An outcome waiting for a confirmation or a reason. */
type Question = 'submit' | 'no-task' | 'review';

const OUTCOME_LABELS = {
  submit: 'Submit and open the next recording',
  noTask: 'No useful task…',
  needsReview: 'Needs review…',
} as const;

export function Workspace(props: WorkspaceProps) {
  const { recording, annotation, canMark, blocked, onDecision, onToast } = props;
  const { info, frames: cameraFrames } = recording;
  const frames = cameraFrames[0]!;
  const { editor, saver } = annotation;
  const state = useSyncExternalStore(editor.subscribe, editor.getState);
  const saveStatus = useSyncExternalStore(saver.subscribe, () => saver.status);

  const { player, setVideo } = useAnnotationPlayer(info.id, frames, annotation);
  const [view] = useState(() => new TimelineView(timelineEndUs(frames)));
  const seekFailed = usePlayer(player, (s) => s.seekFailed);
  const [showCommands, setShowCommands] = useState(false);
  /** The recording's task as its guide is now: the Task tab reads the guide's file again. */
  const [task, setTask] = useState(info.task);
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

  useEffect(() => {
    document.title = `${info.id} · Keep/cut annotator`;
  }, [info.id]);

  // Editing stops once saving has: anything typed after a conflict would be lost. Keys don't
  // edit during a drag either: the drag is one undo step. A recording open in another tab is
  // edited there.
  const editable =
    canMark &&
    recording.seekable &&
    !seekFailed &&
    !saver.stopped &&
    !annotation.openElsewhere &&
    !blocked &&
    asking === null;

  const present = state.history.present;
  const finish = (decision: Decision) => {
    setAsking(null);
    onDecision(decision);
  };

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
    toggleCommandMenu: () => setShowCommands((shown) => !shown),
    // ⌘↵: nothing kept is "no useful task", which N confirms; marks still to check and a keep
    // that runs to the end are worth a second look, so they ask first.
    submit: () => {
      const timeline = editor.getState().history.present;
      if (keepSegments(timeline).length === 0) setAsking('no-task');
      else if (boundariesToCheck(timeline).length > 0 || keepsToEnd(timeline)) setAsking('submit');
      else finish(submitDecision(info.id));
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
    (command) => !blocked && asking === null && (!showCommands || command === 'commandMenu'),
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
  /** Messages whose Undo acts on this recording: they close when this screen does. */
  const ownToasts = useRef(new Set<() => void>());
  useEffect(() => {
    const open = ownToasts.current;
    return () => {
      for (const close of open) close();
    };
  }, []);
  /**
   * Says what a click deleted, with an Undo that goes away once it would undo anything else, or
   * once another recording is on screen.
   */
  const deleted = (text: string) => {
    const after = editor.getState().history.present;
    onToast({
      text,
      action: { label: 'Undo', keys: keysOf('undo'), run: () => latestRun.current('undo') },
      closeWhen: (close) => {
        ownToasts.current.add(close);
        const stop = editor.subscribe(() => {
          if (editor.getState().history.present !== after) close();
        });
        return () => {
          ownToasts.current.delete(close);
          stop();
        };
      },
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
  /** Right-click on the timeline or the list: a kept interval is selected first. */
  const openMenu = (segment: Segment, at: MenuAnchor) => {
    if (segment.state === 'keep') pointer?.selectInterval(segment.start, null);
    const actions = {
      setRange: (from: number, to: number, state: Segment['state']) =>
        pointer?.setRange(from, to, state),
      deleteInterval,
    };
    setMenu({ ...stretchMenu(segment, present, editable, actions), at });
  };
  /** The arrow beside Submit: the other outcomes. A second click closes the menu. */
  const openOutcomes = (owner: HTMLElement) => {
    if (menu?.owner === owner) {
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
  };

  return (
    <>
      <div
        className="workspace"
        style={{ gridTemplateColumns: `minmax(0, 1fr) ${panelWidth}px` }}
        inert={showCommands || blocked || asking === 'review'}
      >
        <TopBar
          queueBar={props.queueBar}
          task={task}
          recordingId={info.id}
          durationS={info.durationS}
          status={state.outcome.status}
          saveStatus={saveStatus}
          editable={editable}
          canUndo={state.history.past.length > 0}
          canRedo={state.history.future.length > 0}
          onRun={run}
          onCommandMenu={() => setShowCommands(true)}
          onOutcomes={openOutcomes}
          onToast={onToast}
        />

        <CameraStage
          cameras={info.cameras}
          frames={cameraFrames}
          player={player}
          onVideo={setVideo}
        >
          {!canMark && (
            <p className="banner" role="alert">
              Annotation needs Chrome or Edge. You can watch here, not mark.
            </p>
          )}
          {!recording.seekable && (
            <p className="banner" role="alert">
              The video server ignores byte ranges, so seeking can't work and marking is off. Please
              report it.
            </p>
          )}
          {seekFailed && (
            <p className="banner" role="alert">
              Couldn't confirm which frame is on screen, or the video didn't load. Marking is off
              until a frame is confirmed; if this stays, reload the page.
            </p>
          )}
          {annotation.openElsewhere && (
            <p className="banner" role="alert">
              This recording is open in another tab, so editing is off here. To edit here, close
              that tab, then{' '}
              <button type="button" onClick={() => location.reload()}>
                Reload
              </button>
            </p>
          )}
          {saver.stopped && (
            <p className="banner" role="alert">
              {saveStatus.kind === 'conflict'
                ? 'This recording was saved from another tab or computer. Editing is off here so nothing is lost.'
                : 'The server refused this annotation, so editing is off.'}{' '}
              <button type="button" onClick={() => location.reload()}>
                Reload
              </button>
            </p>
          )}
          {/* A question waits, without listening, while the queue or command menu is open. */}
          {(asking === 'submit' || asking === 'no-task') && !blocked && !showCommands && (
            <OutcomeQuestion
              question={asking}
              timeline={present}
              recordingId={info.id}
              onDecision={finish}
              onCheck={(frame) => {
                setAsking(null);
                pointer?.goTo(frame);
              }}
              onCancel={() => setAsking(null)}
            />
          )}
        </CameraStage>

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
            Task: (
              <TaskPanel
                task={task}
                onGuide={(now) => {
                  setTask(now);
                  annotation.noteGuide(now.version);
                }}
              />
            ),
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

/** Installs the keymap once; each key press asks for the current handlers and filter. */
function useKeymap(
  handlers: Record<Command, KeyHandler> | null,
  enabled: (command: Command) => boolean,
) {
  const handlerFor = useEffectEvent((command: Command) => handlers?.[command] ?? (() => {}));
  const isEnabled = useEffectEvent((command: Command) => handlers !== null && enabled(command));
  useEffect(() => installKeymap(handlerFor, isEnabled), []);
}
