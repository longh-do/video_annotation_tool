import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { FrameMap } from '../../core/frame-map.ts';
import { segments, type Timeline } from '../../core/timeline.ts';
import { clock } from '../format.ts';
import { type Command, keysOf } from '../keymap.ts';
import { DEFAULT_SPEED, type Player, SKIM_SPEED, SPEEDS } from '../player/player.ts';
import { usePlayer } from '../player/use-player.ts';
import { minSpan, type TimelineView, ZOOM_STEP } from '../timeline-view.ts';
import { ChevronIcon, NextIcon, PauseIcon, PlayIcon, PreviousIcon, SoundIcon } from './icons.tsx';
import { Menu } from './Menu.tsx';
import { StateChip } from './StateChip.tsx';

interface TransportProps {
  readonly player: Player | null;
  readonly timeline: Timeline;
  readonly frames: FrameMap;
  readonly view: TimelineView;
  /** Whether S and D can mark right now. */
  readonly editable: boolean;
  readonly sound: boolean;
  readonly onToggleSound: () => void;
  readonly onSpeed: (speed: number) => void;
  /** Where zooming with the slider centres: the playhead, when it is in view. */
  readonly zoomAnchor: () => number;
  readonly onRun: (command: Command) => void;
}

/**
 * The row above the timeline. Left: the state at the playhead and the Start and Stop buttons
 * (S and D for the mouse). Middle: the time, previous boundary, play/pause, next boundary and the
 * length. Right: speed, sound and zoom. Buttons never take the focus, so keys keep working.
 */
export function Transport(props: TransportProps) {
  const { player, timeline, frames, editable, onRun } = props;
  const playing = usePlayer(player, (s) => s.playing);
  const duration = (frames.ptsUs[frames.ptsUs.length - 1] ?? 0) / 1e6;
  const press = (command: Command) => ({
    onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
    onClick: () => onRun(command),
  });

  return (
    <div className="transport">
      <div className="transport-side">
        <PlayheadState player={player} timeline={timeline} frames={frames} />
        <button
          type="button"
          className="mark-button mark-start"
          disabled={!editable}
          title={`Start here: keep from this frame (${keysOf('keep')})`}
          {...press('keep')}
        >
          Start <kbd>{keysOf('keep')}</kbd>
        </button>
        <button
          type="button"
          className="mark-button mark-stop"
          disabled={!editable}
          title={`Stop here: cut from this frame (${keysOf('cut')})`}
          {...press('cut')}
        >
          Stop <kbd>{keysOf('cut')}</kbd>
        </button>
      </div>
      <div className="transport-middle">
        <Clock player={player} frames={frames} />
        <button
          type="button"
          className="icon-button"
          title={`Previous boundary (${keysOf('previousBoundary')})`}
          aria-label="Previous boundary"
          {...press('previousBoundary')}
        >
          <PreviousIcon />
        </button>
        <button
          type="button"
          className="icon-button play-button"
          title={`${playing ? 'Pause' : 'Play'} (${keysOf('playPause')})`}
          aria-label={playing ? 'Pause' : 'Play'}
          {...press('playPause')}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button"
          className="icon-button"
          title={`Next boundary (${keysOf('nextBoundary')})`}
          aria-label="Next boundary"
          {...press('nextBoundary')}
        >
          <NextIcon />
        </button>
        <span className="duration">{clock(duration)}</span>
      </div>
      <div className="transport-side transport-end">
        <SpeedMenu player={player} onSpeed={props.onSpeed} />
        <SkimButton player={player} />
        <button
          type="button"
          className="icon-button"
          title={
            props.sound ? 'Sound on: a tick on every Start and Stop. Click to mute.' : 'Sound off'
          }
          aria-label={props.sound ? 'Mute the ticks' : 'Turn the ticks on'}
          onMouseDown={(event) => event.preventDefault()}
          onClick={props.onToggleSound}
        >
          <SoundIcon on={props.sound} />
        </button>
        <ZoomSlider view={props.view} anchor={props.zoomAnchor} />
      </div>
    </div>
  );
}

/** Keep or cut at the playhead, and for how long so far. */
function PlayheadState({
  player,
  timeline,
  frames,
}: {
  readonly player: Player | null;
  readonly timeline: Timeline;
  readonly frames: FrameMap;
}) {
  const frame = usePlayer(player, (s) => Math.max(s.frame, 0));
  const runs = useMemo(() => segments(timeline), [timeline]);
  return <StateChip runs={runs} frames={frames} frame={frame} />;
}

/** The time and frame on screen; updates with every presented frame. */
function Clock({ player, frames }: { readonly player: Player | null; readonly frames: FrameMap }) {
  const shown = usePlayer(player, (s) => s.frame);
  const frame = Math.max(shown, 0);
  return (
    <span className="time" data-frame={shown}>
      {clock((frames.ptsUs[frame] ?? 0) / 1e6)}
      <small>frame {frame}</small>
    </span>
  );
}

/** The marking speed, picked from a list; it sticks between recordings. */
function SpeedMenu({
  player,
  onSpeed,
}: {
  readonly player: Player | null;
  readonly onSpeed: (speed: number) => void;
}) {
  const speed = usePlayer(player, (s) => s.speed);
  const skimming = usePlayer(player, (s) => s.skimming);
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="speed"
        title="Playback speed"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setAnchor(anchor ? null : (button.current?.getBoundingClientRect() ?? null))}
      >
        {skimming ? `${SKIM_SPEED}× skim` : `${speed}×`}
        <ChevronIcon />
      </button>
      {anchor && (
        <Menu
          label="Playback speed"
          at={anchor}
          owner={button.current}
          items={SPEEDS.map((choice) => ({
            label: `${choice}×${choice === DEFAULT_SPEED ? ' (default)' : ''}`,
            checked: choice === speed,
            run: () => onSpeed(choice),
          }))}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

/** Skims while held down, as holding F does: for stretches that are clearly not the task. */
function SkimButton({ player }: { readonly player: Player | null }) {
  const skimming = usePlayer(player, (s) => s.skimming);
  const stop = () => player?.skim(false);
  return (
    <button
      type="button"
      className="skim"
      title={`Hold to skim at ${SKIM_SPEED}× (or hold ${keysOf('skim')})`}
      aria-pressed={skimming}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        player?.skim(true);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
    >
      {SKIM_SPEED}× <kbd>{keysOf('skim')}</kbd>
    </button>
  );
}

/**
 * Timeline zoom: − and + buttons around a slider that runs from the whole recording (left) to one
 * second across (right), on a log scale. Pinch and ⌘+ ⌘− do the same.
 */
function ZoomSlider({
  view,
  anchor,
}: {
  readonly view: TimelineView;
  readonly anchor: () => number;
}) {
  const spanUs = useSyncExternalStore(view.subscribe, () => view.view.spanUs);
  const max = view.durationUs;
  const min = minSpan(max);
  const level = min < max ? Math.round((100 * Math.log(spanUs / max)) / Math.log(min / max)) : 0;
  const step = (factor: number) => ({
    onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
    onClick: () => view.zoom(factor, anchor()),
  });
  return (
    <span
      className="zoom"
      title={`Zoom the timeline (pinch, or ${keysOf('zoomIn')} and ${keysOf('zoomOut')})`}
    >
      <button
        type="button"
        className="icon-button"
        aria-label="Zoom the timeline out"
        disabled={level <= 0}
        {...step(1 / ZOOM_STEP)}
      >
        −
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={level}
        disabled={min >= max}
        aria-label="Timeline zoom"
        onChange={(event) =>
          view.zoomTo(max * (min / max) ** (Number(event.target.value) / 100), anchor())
        }
      />
      <button
        type="button"
        className="icon-button"
        aria-label="Zoom the timeline in"
        disabled={level >= 100}
        {...step(ZOOM_STEP)}
      >
        +
      </button>
    </span>
  );
}
