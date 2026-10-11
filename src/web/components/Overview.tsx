import { useEffect, useRef } from 'react';
import { displayedFrame, type FrameMap, frameCount } from '../../core/frame-map.ts';
import { isThrough, keepSegments, type Timeline } from '../../core/timeline.ts';
import type { Player } from '../player/player.ts';
import { usePlayer } from '../player/use-player.ts';

interface OverviewProps {
  readonly player: Player | null;
  readonly timeline: Timeline;
  readonly frames: FrameMap;
  readonly selected: number | null;
  readonly onSeek: (frame: number) => void;
}

/**
 * The whole recording at a glance: kept runs, boundaries (rough ones highlighted until checked,
 * through boundaries dashed) and the playhead. Click or drag to jump. The drawing only changes
 * with the annotation; during playback just the playhead moves.
 */
export function Overview({ player, timeline, frames, selected, onSeek }: OverviewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = usePlayer(player, (s) => Math.max(s.frame, 0));
  const last = frameCount(frames) - 1;
  const endUs = frames.ptsUs[last] || 1;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const redraw = () => draw(element, timeline, frames, selected);
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(element);
    return () => observer.disconnect();
  }, [timeline, frames, selected]);

  const seekTo = (event: React.PointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    onSeek(Math.max(displayedFrame(frames, 0, (fraction * endUs) / 1e6), 0));
  };

  return (
    <div
      className="overview"
      role="slider"
      tabIndex={-1}
      aria-label="Recording overview"
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={frame}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        seekTo(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) seekTo(event);
      }}
    >
      <canvas ref={canvas} />
      <div
        className="playhead"
        style={{ left: `${((frames.ptsUs[frame] ?? 0) / endUs) * 100}%` }}
      />
    </div>
  );
}

function draw(
  canvas: HTMLCanvasElement,
  timeline: Timeline,
  frames: FrameMap,
  selected: number | null,
) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const g = canvas.getContext('2d');
  if (!g) return;
  g.scale(ratio, ratio);
  const color = (name: string) => getComputedStyle(canvas).getPropertyValue(name);
  const last = frameCount(frames) - 1;
  const endUs = frames.ptsUs[last] || 1;
  // Positions by time, not frame index: the frame rate varies. END maps to the right edge.
  const x = (position: number) =>
    position > last ? width : ((frames.ptsUs[position] ?? 0) / endUs) * width;

  g.fillStyle = color('--track');
  g.fillRect(0, 0, width, height);
  g.fillStyle = color('--keep-band');
  for (const run of keepSegments(timeline)) {
    g.fillRect(x(run.start), 0, Math.max(x(run.end) - x(run.start), 1), height);
  }
  timeline.boundaries.forEach((boundary, i) => {
    const isSelected = boundary.frame === selected;
    g.strokeStyle = isSelected
      ? color('--accent')
      : boundary.checked
        ? color('--text')
        : color('--rough');
    g.lineWidth = isSelected ? 3 : 2;
    g.setLineDash(isThrough(timeline, i) ? [3, 3] : []);
    g.beginPath();
    g.moveTo(x(boundary.frame), 0);
    g.lineTo(x(boundary.frame), height);
    g.stroke();
  });
}
