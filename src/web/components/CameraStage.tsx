import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { CameraInfo } from '../../core/api-types.ts';
import type { FrameMap } from '../../core/frame-map.ts';
import { mosaic } from '../mosaic.ts';
import type { Player } from '../player/player.ts';
import { readSetting, writeSetting } from '../settings.ts';
import { CameraTile, CameraView } from './CameraView.tsx';

/** Space between the camera tiles, in CSS pixels. */
const TILE_GAP = 8;

interface CameraStageProps {
  /** The reference camera first. */
  readonly cameras: readonly CameraInfo[];
  /** One frame map per camera, in the same order. */
  readonly frames: readonly FrameMap[];
  readonly player: Player | null;
  /** The reference camera's video, once it is in the page: the player is made on it. */
  readonly onVideo: (video: HTMLVideoElement | null) => void;
  /** Banners and questions, over the cameras. */
  readonly children: ReactNode;
}

/**
 * The cameras: one large, the others stacked beside it, each tile the shape of its video. A click
 * on a small one shows it large, and the choice sticks between recordings. Which camera is large
 * is only a matter of layout: the reference camera counts the frames that marks are saved on,
 * wherever it is shown.
 */
export function CameraStage({ cameras, frames, player, onVideo, children }: CameraStageProps) {
  const reference = cameras[0]!;
  const [large, setLarge] = useState(() => readSetting('mainCamera', reference.label));
  const largeIndex = Math.max(
    cameras.findIndex((c) => c.label === large),
    0,
  );
  /** Big view first, then the others in their order. */
  const areaOf = (index: number) => {
    if (index === largeIndex) return 'main';
    const rank = cameras.filter((_, i) => i !== largeIndex && i < index).length;
    return `side${rank + 1}`;
  };
  const stage = useStageSize();
  const sides = cameras.length - 1;
  const ratioOf = (c: { width: number; height: number }) => c.width / c.height;
  const tiles = mosaic(
    stage.width,
    stage.height,
    {
      main: ratioOf(cameras[largeIndex]!),
      side: Math.max(...cameras.filter((_, i) => i !== largeIndex).map(ratioOf)),
    },
    sides,
    TILE_GAP,
  );
  const showLarge = (label: string) => {
    setLarge(label);
    writeSetting('mainCamera', label);
  };

  return (
    <main className="stage" ref={stage.ref}>
      <div
        className="mosaic"
        style={{
          gridTemplateColumns:
            sides > 0 ? `${tiles.mainWidth}px ${tiles.sideWidth}px` : `${tiles.mainWidth}px`,
          gridTemplateRows: `repeat(${Math.max(sides, 1)}, 1fr)`,
          gridTemplateAreas: Array.from({ length: Math.max(sides, 1) }, (_, i) =>
            sides > 0 ? `"main side${i + 1}"` : '"main"',
          ).join(' '),
          height: tiles.mainHeight,
          gap: TILE_GAP,
        }}
      >
        <CameraTile
          label={reference.label}
          area={areaOf(0)}
          onShowLarge={() => showLarge(reference.label)}
        >
          <video
            ref={onVideo}
            src={reference.videoUrl}
            preload="auto"
            muted
            playsInline
            data-camera={reference.label}
            data-reference=""
            aria-label={`${reference.label} camera, the one annotated`}
          />
        </CameraTile>
        {cameras.slice(1).map((camera, i) => (
          <CameraView
            key={camera.name}
            camera={camera}
            frames={frames[i + 1]!}
            player={player}
            referenceFrames={frames[0]!}
            area={areaOf(i + 1)}
            onShowLarge={() => showLarge(camera.label)}
          />
        ))}
        <div className="stage-overlay">{children}</div>
      </div>
    </main>
  );
}

/** The stage's inner size, kept up to date, for laying out the cameras. */
function useStageSize() {
  const ref = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((was) => (was.width === width && was.height === height ? was : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ...size, ref };
}
