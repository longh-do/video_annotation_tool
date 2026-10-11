import { type ReactNode, useEffect, useState } from 'react';
import type { CameraInfo } from '../../core/api-types.ts';
import { type FrameMap, frameNs, nearestFrame } from '../../core/frame-map.ts';
import { FrameClock } from '../player/frame-clock.ts';
import { type Player, SKIM_SPEED } from '../player/player.ts';
import { SeekQueue } from '../player/seek-queue.ts';
import { usePlayer } from '../player/use-player.ts';

/** Farther than this from every frame of the camera means a gap in its recording. */
export const MAX_SKEW_NS = 150_000_000n;
/**
 * During playback, a camera this far off (in seconds of its video, per 1× of speed) is put back in
 * place. Faster playback moves further between two looks, so the margin grows with the speed.
 */
const DRIFT_S = 0.25;
/** How far ahead (per 1× of speed) a camera that fell behind waits for the head camera. */
const LEAD_S = 0.5;

interface CameraViewProps {
  readonly camera: CameraInfo;
  readonly frames: FrameMap;
  readonly player: Player | null;
  readonly referenceFrames: FrameMap;
  /** Where it sits on the stage: the big view or a small one. */
  readonly area: string;
  readonly onShowLarge: () => void;
}

/**
 * Another camera of the recording. Whenever the head camera, which the marks always come from,
 * stops, it shows its own frame nearest in source time — never the same index or playback time,
 * which don't line up across cameras. Shown large, it also plays along; a small view holds still
 * meanwhile, so only one extra video is ever decoded during playback.
 */
export function CameraView(props: CameraViewProps) {
  const { camera, frames, player, referenceFrames } = props;
  const large = props.area === 'main';
  const referenceFrame = usePlayer(player, (s) => (s.playing ? -1 : s.frame));
  const target =
    referenceFrame < 0
      ? null
      : nearestFrame(frames, frameNs(referenceFrames, referenceFrame), MAX_SKEW_NS);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [queue, setQueue] = useState<SeekQueue | null>(null);

  useEffect(() => {
    if (!video) return;
    const clock = new FrameClock(video, frames);
    setQueue(new SeekQueue(clock, () => {}));
    return () => clock.dispose();
  }, [video, frames]);

  // Paused: exactly the frame that goes with the head camera's.
  useEffect(() => {
    if (queue && target !== null && target >= 0) queue.request(target);
  }, [queue, target]);

  // Playing, when large: along with the head camera at its speed. One that falls behind is put
  // a little ahead and waits there for the head camera, instead of being chased seek after seek.
  useEffect(() => {
    if (!player || !video || !queue) return;
    let waitingAt: number | null = null;
    const stop = () => {
      waitingAt = null;
      if (!video.paused) video.pause();
    };
    if (!large) stop();
    return player.subscribe(() => {
      const { playing, frame, speed, skimming } = player.snapshot;
      if (!large || !playing) {
        stop();
        return;
      }
      const at = nearestFrame(frames, frameNs(referenceFrames, Math.max(frame, 0)), MAX_SKEW_NS);
      if (at < 0) return;
      const due = (frames.ptsUs[at] ?? 0) / 1e6;
      const rate = skimming ? SKIM_SPEED : speed;
      if (video.playbackRate !== rate) video.playbackRate = rate;
      if (waitingAt !== null) {
        if (due < waitingAt) return;
        waitingAt = null;
        video.play().catch(() => {});
        return;
      }
      // While a seek is under way its time is not where the picture is: wait for it.
      const off = !video.seeking && Math.abs(video.currentTime - due) > DRIFT_S * Math.max(rate, 1);
      if (video.paused) {
        queue.cancel();
        if (off) video.currentTime = due;
        video.play().catch(() => {});
      } else if (off) {
        waitingAt = due + LEAD_S * Math.max(rate, 1);
        video.pause();
        video.currentTime = waitingAt;
      }
    });
  }, [player, video, queue, frames, referenceFrames, large]);

  return (
    <CameraTile
      label={camera.label}
      area={props.area}
      note={target === -1 ? 'no frame at this moment' : null}
      onShowLarge={props.onShowLarge}
    >
      <video
        ref={setVideo}
        src={camera.videoUrl}
        preload="auto"
        muted
        playsInline
        data-camera={camera.label}
        aria-label={`${camera.label} camera`}
      />
    </CameraTile>
  );
}

interface CameraTileProps {
  readonly label: string;
  readonly area: string;
  readonly note?: string | null;
  /** A click on a small view shows that camera big instead. */
  readonly onShowLarge: () => void;
  readonly children: ReactNode;
}

/**
 * A camera's place on the stage. Which camera is big is only a matter of layout: no video is
 * ever moved or reloaded, so each keeps its place and the head camera keeps counting frames.
 */
export function CameraTile({ label, area, note, onShowLarge, children }: CameraTileProps) {
  const big = area === 'main';
  return (
    <figure className={`camera${big ? ' camera-main' : ''}`} style={{ gridArea: area }}>
      {children}
      <figcaption>
        {label}
        {note ? ` · ${note}` : ''}
      </figcaption>
      {!big && (
        <button
          type="button"
          className="camera-pick"
          aria-label={`Show the ${label} camera large`}
          title={`Show the ${label} camera large`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onShowLarge}
        />
      )}
    </figure>
  );
}
