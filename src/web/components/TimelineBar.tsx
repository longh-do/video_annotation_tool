import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ThumbnailInfo } from '../../core/api-types.ts';
import {
  displayedFrame,
  type FrameMap,
  frameCount,
  frameNs,
  stopNs,
} from '../../core/frame-map.ts';
import { durationSeconds } from '../../core/ns.ts';
import { keepSegments, type Segment, segments, type Timeline } from '../../core/timeline.ts';
import { clock } from '../format.ts';
import type { Player } from '../player/player.ts';
import { usePlayer } from '../player/use-player.ts';
import { thumbnailAt } from '../thumbnails.ts';
import type { TimelineView, View } from '../timeline-view.ts';
import { prepareCanvas } from './canvas.ts';
import { ScissorsIcon } from './icons.tsx';

interface TimelineBarProps {
  readonly player: Player | null;
  readonly view: TimelineView;
  readonly timeline: Timeline;
  readonly frames: FrameMap;
  /** Frame of the selected boundary. */
  readonly selected: number | null;
  /** The selected kept interval: highlighted, with the others dimmed. */
  readonly interval: Segment | null;
  readonly thumbnails: ThumbnailInfo | null;
  /** False while editing is off: boundaries can't be grabbed or deleted then. */
  readonly editable: boolean;
  readonly onSeek: (frame: number) => void;
  /** A click on the track: the interval there is selected (or nothing, on a cut) and `frame` shown. */
  readonly onSelectInterval: (start: number | null, frame: number) => void;
  readonly onDragStart: (index: number) => void;
  readonly onDrag: (index: number, frame: number) => void;
  readonly onDragEnd: () => void;
  readonly onDragCancel: () => void;
  /** A click on a boundary's badge. */
  readonly onDeleteBoundary: (index: number) => void;
  /** A right-click on a stretch of the track. */
  readonly onMenu: (segment: Segment, at: { readonly x: number; readonly y: number }) => void;
}

/** Layout in CSS pixels: the time ruler, then the track; badges sit on the track's top edge. */
const RULER = 24;
const TRACK_TOP = 34;
const TRACK_HEIGHT = 40;
/** How near a boundary the pointer must be to grab it. */
const GRAB_PX = 6;
/** A badge this close to the one before it is left out (its boundary is still drawn). */
const BADGE_GAP_PX = 18;
/** A press on a badge that moves this far becomes a drag; otherwise it is a click. */
const DRAG_PX = 3;
/** Labels on the ruler are at least this far apart. */
const LABEL_GAP_PX = 64;
const LABEL_STEPS_S = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

type Gesture =
  | { readonly kind: 'scrub'; readonly pointerId: number }
  /** On a badge: a click deletes its boundary, a move drags it. */
  | {
      readonly kind: 'press';
      readonly pointerId: number;
      readonly index: number;
      readonly x: number;
    }
  | { readonly kind: 'drag'; readonly pointerId: number; readonly index: number };

interface Hover {
  readonly x: number;
  readonly frame: number;
  /** A boundary is near enough to grab. */
  readonly grab: boolean;
}

/**
 * The timeline: one bar for the whole recording, with the time ruler on top. Kept intervals are
 * yellow, cuts dark. Pinch or ⌘-scroll zooms, a two-finger swipe or the wheel pans, and the view
 * follows the playhead. Click to jump (a click on an interval selects it), drag to scrub; near a
 * boundary the pointer turns into ↔ and drags it, frame by frame. The badge on top of a boundary
 * deletes it; right-click a stretch for its menu. Escape puts a dragged boundary back.
 */
export function TimelineBar(props: TimelineBarProps) {
  const { player, view: store, timeline, frames, selected, interval, editable } = props;
  const view = useSyncExternalStore(store.subscribe, () => store.view);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  /** Off after a scroll or zoom by hand during playback, until the next play. */
  const following = useRef(true);
  const last = frameCount(frames) - 1;
  const endUs = store.durationUs;

  const usOf = (position: number) => (position > last ? endUs : (frames.ptsUs[position] ?? 0));
  const xOf = (position: number) => ((usOf(position) - view.startUs) / view.spanUs) * width;
  const frameAt = (x: number) => {
    const us = view.startUs + (x / width) * view.spanUs;
    return Math.min(Math.max(displayedFrame(frames, 0, us / 1e6), 0), last);
  };
  /** Index of the boundary within reach of `x`, or -1. */
  const grabbable = (x: number) => {
    let best = -1;
    let distance = GRAB_PX;
    timeline.boundaries.forEach((boundary, i) => {
      const d = Math.abs(xOf(boundary.frame) - x);
      if (d <= distance) {
        best = i;
        distance = d;
      }
    });
    return best;
  };

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (canvas.current && width > 0) {
      draw(canvas.current, { timeline, frames, view, endUs, selected, interval });
    }
  }, [timeline, frames, view, endUs, selected, interval, width]);

  // The view follows the playhead: a page at a time during playback, unless the annotator has
  // scrolled away since it started; when paused, wherever it jumps. Never during a drag or a
  // scrub, which move it on purpose.
  useEffect(() => {
    if (!player) return;
    let shown = { frame: -1, playing: false };
    return player.subscribe(() => {
      const { frame, playing } = player.snapshot;
      // Only a new frame or a start or stop moves the view, not e.g. a change of speed.
      if (frame === shown.frame && playing === shown.playing) return;
      if (playing && !shown.playing) following.current = true;
      shown = { frame, playing };
      if (frame < 0 || gesture.current || (playing && !following.current)) return;
      store.reveal(frames.ptsUs[frame] ?? 0, playing);
    });
  }, [player, store, frames]);

  // Pinch (Chrome reports it as a wheel event with Ctrl) or ⌘/Ctrl + scroll zooms around the
  // pointer; any other scroll pans. The page itself never zooms or swipes back from here.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      following.current = false;
      const rect = element.getBoundingClientRect();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? rect.width
            : 1;
      const { startUs, spanUs } = store.view;
      if (event.ctrlKey || event.metaKey) {
        const delta = Math.min(Math.max(event.deltaY * unit, -50), 50);
        const anchor = startUs + ((event.clientX - rect.left) / rect.width) * spanUs;
        store.zoom(Math.exp(-delta * 0.01), anchor);
      } else {
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        store.pan(((delta * unit) / rect.width) * spanUs);
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [store]);

  const finish = (cancelled: boolean) => {
    const held = gesture.current;
    if (!held) return;
    gesture.current = null;
    if (box.current?.hasPointerCapture(held.pointerId)) {
      box.current.releasePointerCapture(held.pointerId);
    }
    setDragging(false);
    if (held.kind !== 'drag') return;
    if (cancelled) props.onDragCancel();
    else props.onDragEnd();
  };
  const startDrag = (index: number, pointerId: number) => {
    gesture.current = { kind: 'drag', pointerId, index };
    setDragging(true);
    props.onDragStart(index);
  };
  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    const held = gesture.current?.kind;
    if (event.key !== 'Escape' || (held !== 'drag' && held !== 'press')) return;
    event.preventDefault();
    event.stopPropagation();
    finish(true);
  });
  useEffect(() => {
    window.addEventListener('keydown', onEscape, { capture: true });
    return () => window.removeEventListener('keydown', onEscape, { capture: true });
  }, []);

  /** The pointer's place in the bar, held inside it. */
  const at = (event: React.PointerEvent | React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
      y: event.clientY - rect.top,
    };
  };

  // Only the badges in view, and only where there is room for them: a long recording has hundreds.
  const badges = useMemo(() => {
    const shown: Badge[] = [];
    let previous = Number.NEGATIVE_INFINITY;
    timeline.boundaries.forEach((boundary, index) => {
      const x = ((usOfFrame(frames, boundary.frame) - view.startUs) / view.spanUs) * width;
      if (x < -8 || x > width + 8) return;
      if (boundary.frame !== selected && x - previous < BADGE_GAP_PX) return;
      previous = x;
      const kind = boundary.checked ? 'set' : 'unchecked';
      const time = clock((frames.ptsUs[boundary.frame] ?? 0) / 1e6);
      const what = boundary.state === 'keep' ? 'Start' : 'Stop';
      shown.push({ index, frame: boundary.frame, x, kind, time, what });
    });
    return shown;
  }, [timeline, frames, view, width, selected]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a pointer surface; every action on it also has a key
    <div
      ref={box}
      className={`timeline${dragging || hover?.grab ? ' timeline-grab' : ''}`}
      onPointerDown={(event) => {
        // Ctrl-click is a right click on a Mac: it opens the menu, and never deletes or drags.
        if (event.button !== 0 || event.ctrlKey || gesture.current) return;
        const { x, y } = at(event);
        const element = event.currentTarget;
        element.setPointerCapture(event.pointerId);
        const badge = (event.target as HTMLElement).closest<HTMLElement>('[data-badge]');
        if (badge && editable) {
          gesture.current = {
            kind: 'press',
            pointerId: event.pointerId,
            index: Number(badge.dataset.index),
            x,
          };
          return;
        }
        const index = y >= RULER && editable ? grabbable(x) : -1;
        if (index >= 0) {
          startDrag(index, event.pointerId);
          return;
        }
        gesture.current = { kind: 'scrub', pointerId: event.pointerId };
        const frame = frameAt(x);
        if (y < RULER) {
          props.onSeek(frame);
          return;
        }
        const run = segments(timeline).find((s) => s.start <= frame && frame < s.end);
        props.onSelectInterval(run?.state === 'keep' ? run.start : null, frame);
      }}
      onPointerMove={(event) => {
        const { x, y } = at(event);
        const held = gesture.current;
        if (held?.pointerId === event.pointerId) {
          if (held.kind === 'press' && Math.abs(x - held.x) >= DRAG_PX) {
            startDrag(held.index, held.pointerId);
          }
          const now = gesture.current;
          if (now?.kind === 'drag') props.onDrag(now.index, frameAt(x));
          else if (now?.kind === 'scrub') props.onSeek(frameAt(x));
        }
        setHover({ x, frame: frameAt(x), grab: editable && y >= RULER && grabbable(x) >= 0 });
      }}
      onPointerUp={(event) => {
        const held = gesture.current;
        if (held?.pointerId !== event.pointerId) return;
        finish(false);
        // A press counts as a click only if it is let go on the badge it started on.
        const under = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>('[data-badge]');
        if (held.kind === 'press' && under?.dataset.index === String(held.index)) {
          props.onDeleteBoundary(held.index);
        }
      }}
      onPointerCancel={() => finish(true)}
      onPointerLeave={() => {
        if (!gesture.current) setHover(null);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        const { x, y } = at(event);
        if (y < RULER) return;
        const frame = frameAt(x);
        const run = segments(timeline).find((s) => s.start <= frame && frame < s.end);
        if (run) props.onMenu(run, { x: event.clientX, y: event.clientY });
      }}
    >
      <canvas ref={canvas} />
      {badges.map((badge) => (
        <button
          key={badge.frame}
          type="button"
          tabIndex={-1}
          // Never takes the focus, so Space and Enter stay with the shortcuts.
          onMouseDown={(event) => event.preventDefault()}
          data-badge=""
          data-index={badge.index}
          data-frame={badge.frame}
          className={`tl-badge tl-badge-${badge.kind}${badge.frame === selected ? ' tl-badge-selected' : ''}`}
          style={{ left: badge.x }}
          title={badgeTitle(badge)}
          aria-label={`${badge.what} at ${badge.time}${badge.kind === 'unchecked' ? ', needs check' : ''}`}
        >
          {badge.kind === 'unchecked' ? '?' : badge.kind === 'set' ? <ScissorsIcon /> : null}
        </button>
      ))}
      <Playhead player={player} frames={frames} view={view} width={width} />
      {hover && !dragging && (
        <HoverLine hover={hover} frames={frames} thumbnails={props.thumbnails} width={width} />
      )}
    </div>
  );
}

interface Badge {
  readonly index: number;
  readonly frame: number;
  readonly x: number;
  readonly kind: 'set' | 'unchecked';
  readonly time: string;
  readonly what: 'Start' | 'Stop';
}

function badgeTitle({ kind, time, what }: Badge): string {
  if (kind === 'unchecked') {
    return `${what} at ${time} — needs check: marked while the video played, so it may be a few frames late. Enter checks it. Click to delete, drag to move.`;
  }
  return `${what} at ${time}. Click to delete, drag to move.`;
}

function usOfFrame(frames: FrameMap, frame: number): number {
  return frames.ptsUs[frame] ?? 0;
}

/** The playhead moves with every frame: only this redraws then, not the whole bar. */
function Playhead({
  player,
  frames,
  view,
  width,
}: {
  readonly player: Player | null;
  readonly frames: FrameMap;
  readonly view: View;
  readonly width: number;
}) {
  const frame = usePlayer(player, (s) => Math.max(s.frame, 0));
  const x = (((frames.ptsUs[frame] ?? 0) - view.startUs) / view.spanUs) * width;
  if (x < -1 || x > width + 1) return null;
  return (
    <div className="tl-playhead" style={{ transform: `translateX(${x}px)` }}>
      <span className="tl-knob" />
    </div>
  );
}

/** Under the pointer: a line, the time and, from the ingest thumbnails, a picture. */
function HoverLine({
  hover,
  frames,
  thumbnails,
  width,
}: {
  readonly hover: Hover;
  readonly frames: FrameMap;
  readonly thumbnails: ThumbnailInfo | null;
  readonly width: number;
}) {
  const tile = thumbnails && thumbnailAt(thumbnails, hover.frame);
  const half = (thumbnails?.tileWidth ?? 40) / 2 + 4;
  // The preview is centred on the pointer but never sticks out of the bar.
  const left = Math.min(Math.max(hover.x, half), width - half);
  return (
    <>
      <div className="tl-hover" style={{ transform: `translateX(${hover.x}px)` }} />
      <div className="tl-preview" style={{ left }}>
        {tile && thumbnails && (
          <div
            style={{
              width: thumbnails.tileWidth,
              height: thumbnails.tileHeight,
              backgroundImage: `url(${tile.sheetUrl})`,
              backgroundPosition: `-${tile.x}px -${tile.y}px`,
            }}
          />
        )}
        <span>{clock((frames.ptsUs[hover.frame] ?? 0) / 1e6)}</span>
      </div>
    </>
  );
}

interface Drawing {
  readonly timeline: Timeline;
  readonly frames: FrameMap;
  readonly view: View;
  readonly endUs: number;
  readonly selected: number | null;
  readonly interval: Segment | null;
}

/** Ruler, track, intervals and the boundary lines that need attention. Not the playhead. */
function draw(canvas: HTMLCanvasElement, d: Drawing) {
  const ready = prepareCanvas(canvas);
  if (!ready) return;
  const { g, width, height, colors } = ready;
  const { timeline, frames, view, endUs } = d;
  const last = frameCount(frames) - 1;
  const x = (us: number) => ((us - view.startUs) / view.spanUs) * width;
  const at = (position: number) => x(position > last ? endUs : (frames.ptsUs[position] ?? 0));
  g.clearRect(0, 0, width, height);

  // Ruler: a time label every step, dots between, and a tick per frame when there is room.
  const usPerPx = view.spanUs / width;
  const stepS = LABEL_STEPS_S.find((s) => (s * 1e6) / usPerPx >= LABEL_GAP_PX) ?? 3600;
  const stepUs = stepS * 1e6;
  const dots = (stepUs / 5 / usPerPx >= 10 ? 5 : stepUs / 2 / usPerPx >= 10 ? 2 : 1) as number;
  g.font = '11px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillStyle = colors.muted;
  for (
    let t = Math.floor(view.startUs / stepUs) * stepUs;
    t <= view.startUs + view.spanUs;
    t += stepUs
  ) {
    const text = stepS < 1 ? clock(t / 1e6) : clock(t / 1e6).replace(/\.\d$/, '');
    // A label whose time is in view stays whole, even at the very ends.
    const half = g.measureText(text).width / 2 + 1;
    if (x(t) >= 0 && x(t) <= width) {
      g.fillText(text, Math.min(Math.max(x(t), half), width - half), 13);
    }
    for (let k = 1; k < dots; k++) {
      g.beginPath();
      g.arc(x(t + (k * stepUs) / dots), 9, 1, 0, 2 * Math.PI);
      g.fill();
    }
  }
  if (usPerPx * 6 <= (frames.ptsUs[1] ?? 1e9) - (frames.ptsUs[0] ?? 0)) {
    const first = Math.max(displayedFrame(frames, 0, view.startUs / 1e6), 0);
    for (let k = first; k <= last && (frames.ptsUs[k] ?? 0) <= view.startUs + view.spanUs; k++) {
      g.fillRect(x(frames.ptsUs[k] ?? 0), RULER - 5, 1, 4);
    }
  }

  // Track: the recording, cut and hatched, with the kept intervals on top.
  const left = Math.max(x(0), 0);
  const right = Math.min(x(endUs), width);
  g.fillStyle = colors.cut;
  g.beginPath();
  g.roundRect(left, TRACK_TOP, right - left, TRACK_HEIGHT, 6);
  g.fill();
  const hatch = hatchPattern(g, colors.cutHatch);
  if (hatch) {
    g.fillStyle = hatch;
    g.fill();
  }

  for (const run of keepSegments(timeline)) {
    const l = at(run.start);
    const r = at(run.end);
    if (r < 0 || l > width) continue;
    const isSelected = d.interval?.start === run.start;
    const w = Math.max(r - l - 1, 1);
    g.globalAlpha = d.interval && !isSelected ? 0.35 : 1;
    g.fillStyle = isSelected ? colors.keepStrong : colors.keep;
    g.beginPath();
    g.roundRect(l + 0.5, TRACK_TOP, w, TRACK_HEIGHT, Math.min(5, w / 2));
    g.fill();
    // The length, in the middle of the part in view (so it shows when zoomed into the interval).
    const shownLeft = Math.max(l, 0);
    const shownRight = Math.min(l + w, width);
    if (shownRight - shownLeft >= 44) {
      const seconds = durationSeconds(stopNs(frames, run.end) - frameNs(frames, run.start));
      g.fillStyle = colors.onKeep;
      g.fillText(
        `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`,
        (shownLeft + shownRight) / 2,
        TRACK_TOP + 25,
      );
    }
    if (isSelected) {
      g.strokeStyle = colors.text;
      g.lineWidth = 2;
      g.stroke();
      // Trim handles at both ends, as in video editors.
      g.fillStyle = colors.text;
      if (w >= 12) {
        g.fillRect(l + 4, TRACK_TOP + 10, 3, TRACK_HEIGHT - 20);
        g.fillRect(l + w - 6, TRACK_TOP + 10, 3, TRACK_HEIGHT - 20);
      }
    }
  }
  g.globalAlpha = 1;

  // Boundary lines that need attention: the selected one and marks to check. The others are
  // plain from the colours on either side.
  for (const boundary of timeline.boundaries) {
    const bx = at(boundary.frame);
    if (bx < -2 || bx > width + 2) continue;
    const toCheck = !boundary.checked;
    const selected = boundary.frame === d.selected;
    if (!selected && !toCheck) continue;
    g.strokeStyle = selected ? colors.text : colors.unchecked;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(bx, TRACK_TOP);
    g.lineTo(bx, TRACK_TOP + TRACK_HEIGHT);
    g.stroke();
  }
}

/** Thin diagonal lines: cuts differ from kept intervals in pattern as well as colour. */
function hatchPattern(g: CanvasRenderingContext2D, color: string): CanvasPattern | null {
  const tile = new OffscreenCanvas(8, 8);
  const t = tile.getContext('2d');
  if (!t) return null;
  t.strokeStyle = color;
  t.lineWidth = 1;
  t.beginPath();
  t.moveTo(0, 8);
  t.lineTo(8, 0);
  t.stroke();
  return g.createPattern(tile, 'repeat');
}
