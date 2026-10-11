import { useEffect, useRef, useState } from 'react';
import type { ThumbnailInfo } from '../../core/api-types.ts';
import { displayedFrame, type FrameMap, frameCount } from '../../core/frame-map.ts';
import { isThrough, keepSegments, type Timeline } from '../../core/timeline.ts';
import { clock } from '../format.ts';
import type { Player } from '../player/player.ts';
import { usePlayer } from '../player/use-player.ts';
import { thumbnailAt } from '../thumbnails.ts';
import { prepareCanvas } from './canvas.ts';

interface OverviewProps {
  readonly player: Player | null;
  readonly timeline: Timeline;
  readonly frames: FrameMap;
  readonly selected: number | null;
  readonly thumbnails: ThumbnailInfo | null;
  readonly onSeek: (frame: number) => void;
}

/**
 * The whole recording at a glance: kept runs, boundaries (rough ones highlighted until checked,
 * through boundaries dashed) and the playhead. Hover to preview, click or drag to jump. The
 * drawing only changes with the annotation; during playback just the playhead moves.
 */
export function Overview({
  player,
  timeline,
  frames,
  selected,
  thumbnails,
  onSeek,
}: OverviewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = usePlayer(player, (s) => Math.max(s.frame, 0));
  const [hover, setHover] = useState<{ x: number; frame: number } | null>(null);
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

  const frameAt = (event: React.PointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    // The preview is centred on the pointer but never sticks out of the strip.
    const half = (thumbnails?.tileWidth ?? 0) / 2;
    return {
      x: Math.min(Math.max(event.clientX - box.left, half), box.width - half),
      frame: Math.max(displayedFrame(frames, 0, (fraction * endUs) / 1e6), 0),
    };
  };

  return (
    <div
      className="overview"
      title="The whole recording: hover for a preview, click or drag to jump"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        onSeek(frameAt(event).frame);
      }}
      onPointerMove={(event) => {
        const at = frameAt(event);
        if (event.buttons === 1) onSeek(at.frame);
        setHover(at);
      }}
      onPointerLeave={() => setHover(null)}
    >
      <canvas ref={canvas} />
      <div
        className="playhead"
        style={{ left: `${((frames.ptsUs[frame] ?? 0) / endUs) * 100}%` }}
      />
      {hover && thumbnails && <Preview thumbnails={thumbnails} frames={frames} at={hover} />}
    </div>
  );
}

/** The keyframe thumbnail at or before the hovered frame, from the sprite sheets ingest made. */
function Preview({
  thumbnails,
  frames,
  at,
}: {
  readonly thumbnails: ThumbnailInfo;
  readonly frames: FrameMap;
  readonly at: { x: number; frame: number };
}) {
  const tile = thumbnailAt(thumbnails, at.frame);
  if (!tile) return null;
  const { tileWidth: width, tileHeight: height } = thumbnails;
  return (
    <div className="preview" style={{ left: at.x, width }}>
      <div
        style={{
          width,
          height,
          backgroundImage: `url(${tile.sheetUrl})`,
          backgroundPosition: `-${tile.x}px -${tile.y}px`,
        }}
      />
      <span>{clock((frames.ptsUs[at.frame] ?? 0) / 1e6)}</span>
    </div>
  );
}

function draw(
  canvas: HTMLCanvasElement,
  timeline: Timeline,
  frames: FrameMap,
  selected: number | null,
) {
  const ready = prepareCanvas(canvas);
  if (!ready) return;
  const { g, width, height, colors } = ready;
  const last = frameCount(frames) - 1;
  const endUs = frames.ptsUs[last] || 1;
  // Positions by time, not frame index: the frame rate varies. END maps to the right edge.
  const x = (position: number) =>
    position > last ? width : ((frames.ptsUs[position] ?? 0) / endUs) * width;

  g.fillStyle = colors.track;
  g.fillRect(0, 0, width, height);
  g.fillStyle = colors.keepBand;
  for (const run of keepSegments(timeline)) {
    g.fillRect(x(run.start), 0, Math.max(x(run.end) - x(run.start), 1), height);
  }
  timeline.boundaries.forEach((boundary, i) => {
    const isSelected = boundary.frame === selected;
    g.strokeStyle = isSelected ? colors.accent : boundary.checked ? colors.text : colors.rough;
    g.lineWidth = isSelected ? 3 : 2;
    g.setLineDash(isThrough(timeline, i) ? [3, 3] : []);
    g.beginPath();
    g.moveTo(x(boundary.frame), 0);
    g.lineTo(x(boundary.frame), height);
    g.stroke();
  });
}
