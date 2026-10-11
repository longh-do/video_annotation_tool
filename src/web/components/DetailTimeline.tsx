import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { displayedFrame, type FrameMap, frameCount } from '../../core/frame-map.ts';
import { isThrough, keepSegments, type Timeline } from '../../core/timeline.ts';
import { clock } from '../format.ts';
import type { Player } from '../player/player.ts';
import { usePlayer } from '../player/use-player.ts';
import { prepareCanvas } from './canvas.ts';

/** Half the visible window, in microseconds of video time. */
const HALF_WINDOW_US = 10_000_000;

interface DetailTimelineProps {
  readonly player: Player | null;
  readonly timeline: Timeline;
  readonly frames: FrameMap;
  readonly selected: number | null;
  readonly onSeek: (frame: number) => void;
  readonly onDragStart: (index: number) => void;
  readonly onDrag: (index: number, frame: number) => void;
  readonly onDragEnd: () => void;
  readonly onDragCancel: () => void;
}

/**
 * Twenty seconds around the playhead, with a tick per frame (their spacing shows the variable
 * frame rate). Boundary handles drag and snap to frames; Escape puts a dragged boundary back.
 * While a handle is held the window stays put, so the video can show the frame under the pointer
 * without the timeline sliding away.
 */
export function DetailTimeline(props: DetailTimelineProps) {
  const { player, timeline, frames, selected, onSeek } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const playhead = usePlayer(player, (s) => Math.max(s.frame, 0));
  const [frozenCenterUs, setFrozenCenterUs] = useState<number | null>(null);
  const centerUs = frozenCenterUs ?? frames.ptsUs[playhead] ?? 0;
  const [width, setWidth] = useState(0);
  /** The handle being dragged, until it is let go or the drag is cancelled. */
  const drag = useRef<{ element: HTMLElement; pointerId: number; index: number } | null>(null);

  const finishDrag = (cancelled: boolean) => {
    const held = drag.current;
    if (!held) return;
    drag.current = null;
    if (held.element.hasPointerCapture(held.pointerId)) {
      held.element.releasePointerCapture(held.pointerId);
    }
    setFrozenCenterUs(null);
    if (cancelled) props.onDragCancel();
    else props.onDragEnd();
  };
  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !drag.current) return;
    event.preventDefault();
    event.stopPropagation();
    finishDrag(true);
  });
  useEffect(() => {
    window.addEventListener('keydown', onEscape, { capture: true });
    return () => window.removeEventListener('keydown', onEscape, { capture: true });
  }, []);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (canvas.current && width > 0) draw(canvas.current, timeline, frames, centerUs, playhead);
  }, [timeline, frames, centerUs, playhead, width]);

  const xOf = (frame: number) => {
    const us =
      frame >= frameCount(frames)
        ? (frames.ptsUs[frameCount(frames) - 1] ?? 0)
        : (frames.ptsUs[frame] ?? 0);
    return ((us - centerUs) / (2 * HALF_WINDOW_US) + 0.5) * width;
  };
  const frameAt = (clientX: number, box: DOMRect) => {
    const us = centerUs + ((clientX - box.left) / box.width - 0.5) * 2 * HALF_WINDOW_US;
    return Math.max(displayedFrame(frames, 0, us / 1e6), 0);
  };

  return (
    <div className="detail">
      <canvas
        ref={canvas}
        title="Twenty seconds around the playhead: click to jump"
        onPointerDown={(event) =>
          onSeek(frameAt(event.clientX, event.currentTarget.getBoundingClientRect()))
        }
      />
      {timeline.boundaries.map((boundary, index) => {
        const x = xOf(boundary.frame);
        if (x < -8 || x > width + 8) return null;
        const label = `${boundary.state === 'keep' ? 'Keep' : 'Cut'} from ${clock((frames.ptsUs[boundary.frame] ?? 0) / 1e6)}`;
        return (
          <div
            // Keyed by index: a dragged boundary changes frame but keeps its index (and the
            // element keeps the pointer capture).
            key={index}
            data-frame={boundary.frame}
            title={`${label}: drag to move`}
            className={[
              'handle',
              `handle-${boundary.state}`,
              boundary.checked ? '' : 'handle-rough',
              isThrough(timeline, index) ? 'handle-through' : '',
              boundary.frame === selected ? 'handle-selected' : '',
            ].join(' ')}
            style={{ left: x }}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (drag.current || event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { element: event.currentTarget, pointerId: event.pointerId, index };
              setFrozenCenterUs(centerUs);
              props.onDragStart(index);
            }}
            onPointerMove={(event) => {
              if (drag.current?.pointerId !== event.pointerId) return;
              const box = event.currentTarget.parentElement?.getBoundingClientRect();
              // Held inside the window: a handle dragged off the edge would unmount.
              const x = box && Math.min(Math.max(event.clientX, box.left), box.right);
              if (box && x !== undefined) props.onDrag(index, frameAt(x, box));
            }}
            onPointerUp={() => finishDrag(false)}
            onPointerCancel={() => finishDrag(true)}
          />
        );
      })}
    </div>
  );
}

function draw(
  canvas: HTMLCanvasElement,
  timeline: Timeline,
  frames: FrameMap,
  centerUs: number,
  playhead: number,
) {
  const ready = prepareCanvas(canvas);
  if (!ready) return;
  const { g, width, height, colors } = ready;
  const startUs = centerUs - HALF_WINDOW_US;
  const endUs = centerUs + HALF_WINDOW_US;
  const last = frameCount(frames) - 1;
  const x = (us: number) => ((us - startUs) / (endUs - startUs)) * width;
  const usOf = (position: number) =>
    position > last ? (frames.ptsUs[last] ?? 0) + 33_333 : (frames.ptsUs[position] ?? 0);

  g.fillStyle = colors.track;
  g.fillRect(0, 0, width, height);
  g.fillStyle = colors.keepBand;
  for (const run of keepSegments(timeline)) {
    const left = x(usOf(run.start));
    const right = x(usOf(run.end));
    if (right >= 0 && left <= width) g.fillRect(left, 0, right - left, height);
  }

  // A tick per frame, and the time at each whole second.
  g.fillStyle = colors.muted;
  const first = Math.max(displayedFrame(frames, 0, startUs / 1e6), 0);
  for (let k = first; k <= last && (frames.ptsUs[k] ?? 0) <= endUs; k++) {
    g.fillRect(x(frames.ptsUs[k] ?? 0), height - 6, 1, 6);
  }
  g.font = '11px system-ui, sans-serif';
  for (let s = Math.ceil(Math.max(startUs, 0) / 1e6); s * 1e6 <= endUs; s++) {
    g.fillText(clock(s), x(s * 1e6) + 3, 12);
    g.fillRect(x(s * 1e6), height - 12, 1, 12);
  }

  // Only the boundaries in view: a long recording has hundreds.
  timeline.boundaries.forEach((boundary, i) => {
    const bx = x(usOf(boundary.frame));
    if (bx < -2 || bx > width + 2) return;
    g.strokeStyle = boundary.checked ? colors.text : colors.rough;
    g.setLineDash(isThrough(timeline, i) ? [3, 3] : []);
    g.beginPath();
    g.moveTo(bx, 0);
    g.lineTo(bx, height);
    g.stroke();
  });
  g.setLineDash([]);
  g.fillStyle = colors.playhead;
  g.fillRect(x(usOf(playhead)) - 1, 0, 2, height);
}
