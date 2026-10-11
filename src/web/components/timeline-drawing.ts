/**
 * The timeline's canvas: the time ruler, the track with its intervals, and the boundary lines that
 * need attention. The playhead, badges and hover line are elements on top (TimelineBar).
 */
import type { CSSProperties } from 'react';
import {
  displayedFrame,
  type FrameMap,
  frameCount,
  frameNs,
  stopNs,
} from '../../core/frame-map.ts';
import { durationSeconds } from '../../core/ns.ts';
import { keepSegments, type Segment, type Timeline } from '../../core/timeline.ts';
import { clock } from '../format.ts';
import { scaleOf, type View } from '../timeline-view.ts';
import { prepareCanvas } from './canvas.ts';

/**
 * Layout in CSS pixels: the time ruler, then the track; badges sit on the track's top edge. The
 * stylesheet gets these as variables (`layoutStyle`), so they are defined here only.
 */
export const RULER = 24;
const TRACK_TOP = 34;
const TRACK_HEIGHT = 40;
const BOTTOM = 4;

/** Labels on the ruler are at least this far apart. */
const LABEL_GAP_PX = 64;
const LABEL_STEPS_S = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** The layout as CSS variables, for the timeline's element. */
export const layoutStyle = {
  '--tl-track-top': `${TRACK_TOP}px`,
  '--tl-height': `${TRACK_TOP + TRACK_HEIGHT + BOTTOM}px`,
} as CSSProperties;

export interface Drawing {
  readonly timeline: Timeline;
  readonly frames: FrameMap;
  readonly view: View;
  readonly endUs: number;
  readonly selected: number | null;
  readonly interval: Segment | null;
}

/** Ruler, track, intervals and the boundary lines that need attention. Not the playhead. */
export function draw(canvas: HTMLCanvasElement, d: Drawing) {
  const ready = prepareCanvas(canvas);
  if (!ready) return;
  const { g, width, height, colors } = ready;
  const { timeline, frames, view, endUs } = d;
  const last = frameCount(frames) - 1;
  const { xOfUs: x, xOf: at } = scaleOf(view, width, frames, endUs);
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
      g.fillRect(at(k), RULER - 5, 1, 4);
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
      // Trim handles, as in video editors, on the edges that are boundaries: an interval that
      // runs to the end of the recording has nothing to drag there.
      g.fillStyle = colors.text;
      if (w >= 12) {
        g.fillRect(l + 4, TRACK_TOP + 10, 3, TRACK_HEIGHT - 20);
        if (run.end <= last) g.fillRect(l + w - 6, TRACK_TOP + 10, 3, TRACK_HEIGHT - 20);
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
