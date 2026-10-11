import { useEffect, useState } from 'react';
import type { CameraInfo } from '../../core/api-types.ts';
import { type FrameMap, frameNs, nearestFrame } from '../../core/frame-map.ts';
import { FrameClock } from '../player/frame-clock.ts';
import type { Player } from '../player/player.ts';
import { SeekQueue } from '../player/seek-queue.ts';
import { usePlayer } from '../player/use-player.ts';

/** Farther than this from every frame of the camera means a gap in its recording. */
const MAX_SKEW_NS = 150_000_000n;

interface CameraViewProps {
  readonly camera: CameraInfo;
  readonly frames: FrameMap;
  readonly player: Player | null;
  readonly referenceFrames: FrameMap;
}

/**
 * A secondary camera. It holds still during playback and, whenever the reference video stops,
 * shows its own frame nearest in source time — never the same index or playback time, which
 * don't line up across cameras.
 */
export function CameraView({ camera, frames, player, referenceFrames }: CameraViewProps) {
  const referenceFrame = usePlayer(player, (s) => (s.playing ? -1 : s.frame));
  const frozen = referenceFrame < 0;
  const target = frozen
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

  useEffect(() => {
    if (queue && target !== null && target >= 0) queue.request(target);
  }, [queue, target]);

  return (
    <figure className={`camera${frozen ? ' camera-frozen' : ''}`}>
      <video
        ref={setVideo}
        src={camera.videoUrl}
        preload="auto"
        muted
        playsInline
        data-camera={camera.label}
        aria-label={`${camera.label} camera`}
      />
      <figcaption>
        {camera.label}
        {frozen ? ' · updates when paused' : target === -1 ? ' · no frame at this moment' : ''}
      </figcaption>
    </figure>
  );
}
