import { useSyncExternalStore } from 'react';
import { DEFAULT_SPEED, type Player, type PlayerSnapshot } from './player.ts';

const STOPPED: PlayerSnapshot = {
  frame: -1,
  playing: false,
  speed: DEFAULT_SPEED,
  skimming: false,
  seekFailed: false,
};
const noSubscription = () => () => {};

/**
 * One value from the player. The snapshot changes with every presented frame, so components pick
 * what they show: only those that show the current frame re-render 30–60 times a second, and the
 * frame callbacks never queue behind a full re-render.
 */
export function usePlayer<T>(player: Player | null, select: (snapshot: PlayerSnapshot) => T): T {
  return useSyncExternalStore(player?.subscribe ?? noSubscription, () =>
    select(player?.snapshot ?? STOPPED),
  );
}
