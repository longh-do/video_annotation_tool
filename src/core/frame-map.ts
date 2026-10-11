/**
 * Frame maps: which source-clock timestamp each video frame shows.
 *
 * There is one map per camera, parsed from its frames CSV
 * (`video_file,frame_index,video_time_s,source_ts_ns,source_frame_id`). A frame is identified by
 * its row index, counted across all of the camera's video parts. Each frame has two clocks:
 * - `ptsUs`: presentation time inside its own MP4 part, in integer microseconds. The CSV keeps
 *   six decimals, so this is exact, and integers this size are exact in a double.
 * - `tsNs`: the source clock in nanoseconds, strictly increasing across parts.
 *
 * Positions run from 0 to the frame count. A position is where an interval starts or stops: an
 * interval keeps the frames from its start position up to, not including, its stop position.
 */
import { isNsString, parseNs } from './ns.ts';

export interface VideoPart {
  /** File name as written in the CSV, e.g. `head-0000.mp4`. */
  readonly file: string;
  readonly firstFrame: number;
  readonly frameCount: number;
}

export interface FrameMap {
  readonly parts: readonly VideoPart[];
  readonly ptsUs: Float64Array;
  readonly tsNs: BigInt64Array;
}

const SECONDS = /^(\d+)(?:\.(\d{1,6}))?$/;

/** Parses a frames CSV. Throws with the line number on anything the lookups can't rely on. */
export function parseFramesCsv(text: string): FrameMap {
  const lines = text
    .replace(/^﻿/, '')
    .split('\n')
    .map((line) => line.trimEnd());
  while (lines.at(-1) === '') lines.pop();
  const header = (lines[0] ?? '').split(',');
  const column = (name: string): number => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`frames CSV: missing column "${name}"`);
    return index;
  };
  const fileCol = column('video_file');
  const timeCol = column('video_time_s');
  const tsCol = column('source_ts_ns');

  const rows = lines.length - 1;
  if (rows < 1) throw new Error('frames CSV: no frames');
  const ptsUs = new Float64Array(rows);
  const tsNs = new BigInt64Array(rows);
  const parts: VideoPart[] = [];

  for (let row = 0; row < rows; row++) {
    const line = row + 2;
    const cells = (lines[row + 1] ?? '').split(',');
    if (cells.length !== header.length) throw csvError(line, `expected ${header.length} columns`);
    const file = cells[fileCol] ?? '';
    const time = SECONDS.exec(cells[timeCol] ?? '');
    if (!time) throw csvError(line, 'video_time_s must be seconds with at most 6 decimals');
    const [, whole = '', fraction = ''] = time;
    // biome-ignore lint/plugin/no-number-ns: digits of a video time in seconds, not a timestamp
    ptsUs[row] = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
    const ts = cells[tsCol] ?? '';
    if (!isNsString(ts)) throw csvError(line, 'source_ts_ns must be a non-negative integer');
    tsNs[row] = parseNs(ts);

    const part = parts.at(-1);
    if (part?.file === file) {
      parts[parts.length - 1] = { ...part, frameCount: part.frameCount + 1 };
      if (ptsUs[row]! <= ptsUs[row - 1]!) throw csvError(line, 'video_time_s must increase');
    } else {
      if (parts.some((p) => p.file === file))
        throw csvError(line, `${file} rows must be contiguous`);
      parts.push({ file, firstFrame: row, frameCount: 1 });
    }
    if (row > 0 && tsNs[row]! <= tsNs[row - 1]!) {
      throw csvError(line, 'source_ts_ns must strictly increase');
    }
  }
  return { parts, ptsUs, tsNs };
}

function csvError(line: number, problem: string): Error {
  return new Error(`frames CSV line ${line}: ${problem}`);
}

export function frameCount(map: FrameMap): number {
  return map.tsNs.length;
}

/** The source timestamp of a frame: where an interval starting at it starts. */
export function frameNs(map: FrameMap, frame: number): bigint {
  const ns = map.tsNs[frame];
  if (ns === undefined) throw new RangeError(`no frame ${frame}`);
  return ns;
}

/**
 * Where an interval stopping at `position` stops. Right after the last frame of a video part (at
 * END, or on the next part's first frame) that is one nanosecond after the last frame, so the
 * interval keeps that frame but not the gap after it. Anywhere else it is the frame's timestamp.
 */
export function stopNs(map: FrameMap, position: number): bigint {
  const endsPart =
    position === frameCount(map) ||
    map.parts.some((p) => p.firstFrame === position && position > 0);
  return endsPart ? frameNs(map, position - 1) + 1n : frameNs(map, position);
}

/**
 * The position a source timestamp stands for: the inverse of `frameNs` and `stopNs`. Any other
 * timestamp snaps to the frame on screen at that moment, as the contract says; anything after the
 * last frame is END.
 */
export function positionAtNs(map: FrameMap, ns: bigint): number {
  const after = firstAtOrAfter(map.tsNs, ns);
  if (after === 0 || after === frameCount(map) || map.tsNs[after] === ns) return after;
  const before = after - 1;
  const endsPart = map.parts.some((p) => p.firstFrame + p.frameCount === after);
  return endsPart && ns === map.tsNs[before]! + 1n ? after : before;
}

/**
 * The frame on screen when a part's video clock reads `seconds` (`currentTime`, or the `mediaTime`
 * of a video frame callback): the last frame of that part presented at or before it, or -1 before
 * the part's first frame. The time is rounded to whole microseconds first: browsers report a
 * frame's exact presentation time as a double, and 2.076348 * 1e6 is 2076347.9999999998, which
 * would otherwise land on the previous frame. Never round to the nearest frame instead: a browser
 * may report any time inside a frame, e.g. the seek target.
 */
export function displayedFrame(map: FrameMap, part: number, seconds: number): number {
  const p = map.parts[part];
  if (!p) throw new RangeError(`no video part ${part}`);
  const us = Math.round(seconds * 1e6);
  let lo = p.firstFrame;
  let hi = p.firstFrame + p.frameCount;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (map.ptsUs[mid]! <= us) lo = mid + 1;
    else hi = mid;
  }
  return lo === p.firstFrame ? -1 : lo - 1;
}

/**
 * The frame whose timestamp is nearest to `ns` (ties go to the earlier frame), or -1 when even the
 * nearest one is more than `maxDistanceNs` away, e.g. inside a gap in a secondary camera.
 */
export function nearestFrame(map: FrameMap, ns: bigint, maxDistanceNs?: bigint): number {
  const ts = map.tsNs;
  const after = Math.min(firstAtOrAfter(ts, ns), ts.length - 1);
  const before = Math.max(after - 1, 0);
  const nearest = distance(ts[before]!, ns) <= distance(ts[after]!, ns) ? before : after;
  if (maxDistanceNs !== undefined && distance(ts[nearest]!, ns) > maxDistanceNs) return -1;
  return nearest;
}

/** First index whose value is >= x, or the array length. */
function firstAtOrAfter(values: BigInt64Array, x: bigint): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function distance(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}
