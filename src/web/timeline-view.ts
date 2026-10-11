import { displayedFrame, type FrameMap, frameCount } from '../core/frame-map.ts';

/**
 * Which stretch of the recording the timeline shows. Zoomed out, the whole recording; zoomed in,
 * a window that pans and follows the playhead. Times are microseconds of video time. The rules
 * are pure functions (unit-tested); `TimelineView` holds the current view for the timeline, the
 * zoom keys and the zoom slider.
 */
export interface View {
  /** The time at the left edge. */
  readonly startUs: number;
  /** How much time the full width shows. */
  readonly spanUs: number;
}

/** The zoom buttons and ⌘+ ⌘− zoom by this much. */
export const ZOOM_STEP = 1.5;
/** The closest zoom: one second across the width, about 40 px per frame. */
const MIN_SPAN_US = 1_000_000;
/** During playback the view turns a page when the playhead gets this close to the right edge. */
const PAGE_AT = 0.95;
/** …and puts it back this far from the left edge. */
const PAGE_TO = 0.05;

/** Where the timeline ends: one frame after the last one starts, so the last frame has a width. */
export function timelineEndUs(frames: FrameMap): number {
  const last = frameCount(frames) - 1;
  const lastUs = frames.ptsUs[last] ?? 0;
  const gapUs = last > 0 ? lastUs - (frames.ptsUs[last - 1] ?? 0) : 33_333;
  return lastUs + gapUs;
}

export function fit(durationUs: number): View {
  return { startUs: 0, spanUs: durationUs };
}

/** The narrowest span the recording can be zoomed to. */
export function minSpan(durationUs: number): number {
  return Math.min(MIN_SPAN_US, durationUs);
}

/** Within the recording, and between the closest zoom and the whole recording. */
export function clamp(view: View, durationUs: number): View {
  const spanUs = Math.min(Math.max(view.spanUs, minSpan(durationUs)), durationUs);
  const startUs = Math.min(Math.max(view.startUs, 0), durationUs - spanUs);
  return { startUs, spanUs };
}

/** Zoomed by `factor` (above 1 zooms in) with `anchorUs` staying where it is on screen. */
export function zoomed(view: View, durationUs: number, factor: number, anchorUs: number): View {
  const spanUs = view.spanUs / factor;
  const at = (anchorUs - view.startUs) / view.spanUs;
  return clamp({ startUs: anchorUs - at * spanUs, spanUs }, durationUs);
}

export function panned(view: View, durationUs: number, deltaUs: number): View {
  return clamp({ startUs: view.startUs + deltaUs, spanUs: view.spanUs }, durationUs);
}

/**
 * The view that shows `us`. While playing it turns a page as the playhead nears the right edge;
 * otherwise a time off screen is centred. A time already in view changes nothing.
 */
export function revealed(view: View, durationUs: number, us: number, playing: boolean): View {
  const end = view.startUs + view.spanUs;
  if (playing) {
    if (us >= view.startUs && us <= view.startUs + PAGE_AT * view.spanUs) return view;
    return clamp({ startUs: us - PAGE_TO * view.spanUs, spanUs: view.spanUs }, durationUs);
  }
  if (us >= view.startUs && us <= end) return view;
  return clamp({ startUs: us - view.spanUs / 2, spanUs: view.spanUs }, durationUs);
}

/**
 * Where things fall on a bar `width` pixels wide that shows `view`, and back: the one place the
 * timeline turns frames and times into x.
 */
export function scaleOf(view: View, width: number, frames: FrameMap, endUs: number) {
  const last = frameCount(frames) - 1;
  const xOfUs = (us: number) => ((us - view.startUs) / view.spanUs) * width;
  return {
    xOfUs,
    /** A frame's left edge; END (`frameCount`) is the end of the recording. */
    xOf: (position: number) => xOfUs(position > last ? endUs : (frames.ptsUs[position] ?? 0)),
    /** The frame on screen at `x`. */
    frameAt: (x: number) => {
      const us = view.startUs + (x / width) * view.spanUs;
      return Math.min(Math.max(displayedFrame(frames, 0, us / 1e6), 0), last);
    },
  };
}

/** The view a store holds; the timeline subscribes to it. */
export class TimelineView {
  readonly durationUs: number;
  #view: View;
  readonly #listeners = new Set<() => void>();

  constructor(durationUs: number) {
    this.durationUs = durationUs;
    this.#view = fit(durationUs);
  }

  get view(): View {
    return this.#view;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  zoom(factor: number, anchorUs: number): void {
    this.#set(zoomed(this.#view, this.durationUs, factor, anchorUs));
  }

  /** Shows `spanUs` of time, keeping `anchorUs` where it is (the zoom slider). */
  zoomTo(spanUs: number, anchorUs: number): void {
    this.zoom(this.#view.spanUs / spanUs, anchorUs);
  }

  fit(): void {
    this.#set(fit(this.durationUs));
  }

  pan(deltaUs: number): void {
    this.#set(panned(this.#view, this.durationUs, deltaUs));
  }

  reveal(us: number, playing: boolean): void {
    this.#set(revealed(this.#view, this.durationUs, us, playing));
  }

  #set(view: View): void {
    if (view.startUs === this.#view.startUs && view.spanUs === this.#view.spanUs) return;
    this.#view = view;
    for (const listener of this.#listeners) listener();
  }
}
