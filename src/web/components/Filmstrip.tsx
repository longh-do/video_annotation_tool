import { useEffect, useMemo, useRef, useState } from 'react';
import { filmstripFrames } from '../../core/check.ts';
import { type FrameMap, frameNs } from '../../core/frame-map.ts';
import { durationSeconds } from '../../core/ns.ts';
import type { FrameGrabber } from '../player/frame-grabber.ts';

interface FilmstripProps {
  readonly grabber: FrameGrabber | null;
  readonly frames: FrameMap;
  /** Where the check started: the strip stays put while the boundary moves. */
  readonly anchor: number;
  /** Where the boundary is now. */
  readonly boundary: number;
  readonly onPick: (frame: number) => void;
}

/**
 * About 1.5 s before to 0.5 s after the mark being checked. Live marks land late, so the true
 * boundary is usually left of the mark. Click a frame to move the boundary there. Key it by
 * `anchor`: each strip starts empty.
 */
export function Filmstrip({ grabber, frames, anchor, boundary, onPick }: FilmstripProps) {
  const strip = useMemo(() => filmstripFrames(frames, anchor), [frames, anchor]);
  const [bitmaps, setBitmaps] = useState<ReadonlyMap<number, ImageBitmap>>(new Map());

  useEffect(() => {
    if (!grabber) return;
    // Grabs for a strip that is gone are skipped, so a quick check pass never waits for them.
    const gone = new AbortController();
    // Nearest the mark first: those are the frames the annotator looks at first.
    const order = [...strip].sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor));
    for (const frame of order) {
      void grabber.grab(frame, gone.signal).then((bitmap) => {
        if (!gone.signal.aborted && bitmap)
          setBitmaps((shown) => new Map(shown).set(frame, bitmap));
      });
    }
    return () => gone.abort();
  }, [grabber, strip, anchor]);

  const offset = (frame: number) => {
    const seconds = durationSeconds(frameNs(frames, frame) - frameNs(frames, anchor));
    return frame === anchor
      ? 'mark'
      : `${seconds > 0 ? '+' : '−'}${Math.abs(seconds).toFixed(2)} s`;
  };

  return (
    <fieldset className="filmstrip">
      <legend>Frames around the mark</legend>
      {strip.map((frame) => (
        <button
          key={frame}
          type="button"
          className={`thumb${frame === boundary ? ' thumb-boundary' : ''}${frame === anchor ? ' thumb-mark' : ''}`}
          title={`Move the boundary to frame ${frame}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(frame)}
        >
          <Picture bitmap={bitmaps.get(frame)} />
          <span>{offset(frame)}</span>
        </button>
      ))}
    </fieldset>
  );
}

/** The frame once it has been grabbed; an empty box until then. */
function Picture({ bitmap }: { readonly bitmap: ImageBitmap | undefined }) {
  return bitmap ? <Bitmap bitmap={bitmap} /> : <span className="thumb-empty" />;
}

function Bitmap({ bitmap }: { readonly bitmap: ImageBitmap }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    element.width = bitmap.width;
    element.height = bitmap.height;
    element.getContext('2d')?.drawImage(bitmap, 0, 0);
  }, [bitmap]);
  return <canvas ref={canvas} />;
}
