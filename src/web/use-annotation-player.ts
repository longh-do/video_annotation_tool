/**
 * The player of the annotation screen: made on the reference camera's video once it is in the
 * page, opened at the frame a link names or where the recording was left, and wired to the
 * recording's annotation for active time, telemetry and where to reopen.
 */
import { useEffect, useRef, useState } from 'react';
import type { FrameMap } from '../core/frame-map.ts';
import type { AnnotationSession } from './annotation-session.ts';
import { placeFromHash } from './location.ts';
import { DEFAULT_SPEED, Player, SKIM_SPEED } from './player/player.ts';
import { readResumeFrame, readSetting, writeResumeFrame } from './settings.ts';

export function useAnnotationPlayer(
  recordingId: string,
  frames: FrameMap,
  annotation: AnnotationSession,
) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);

  useEffect(() => {
    if (!video) return;
    const created = new Player(video, frames, readSetting('speed', DEFAULT_SPEED));
    setPlayer(created);
    return () => created.dispose();
  }, [video, frames]);

  // Open at the frame a link names, else where this recording was left. An applied link is
  // trimmed from the URL, so a reload reopens where the annotator was, not at the old link. The
  // choice is made once: the effect can run again (a new player) after the link is gone.
  const opening = useRef<number | null>(null);
  useEffect(() => {
    if (!player) return;
    const linkedFrame = () => {
      const place = placeFromHash();
      if (place.recordingId !== recordingId || place.frame === null) return null;
      history.replaceState(null, '', `#${encodeURIComponent(recordingId)}`);
      return place.frame;
    };
    opening.current ??= linkedFrame() ?? readResumeFrame(recordingId) ?? annotation.place.frame;
    if (opening.current > 0) player.seek(opening.current);
    const followLink = () => {
      const frame = linkedFrame();
      if (frame !== null) player.seek(frame);
    };
    window.addEventListener('hashchange', followLink);
    return () => window.removeEventListener('hashchange', followLink);
  }, [player, annotation, recordingId]);

  // The annotation saves where the annotator is (to reopen there on another computer) and counts
  // active time while this screen is open: playing, or keys and pointer in the last 30 s.
  useEffect(() => {
    if (!player) return;
    const detach = annotation.attach(() => ({
      frame: player.frame,
      playbackRate: player.snapshot.speed,
    }));
    const active = () => annotation.noteInput();
    window.addEventListener('keydown', active, { capture: true });
    window.addEventListener('pointerdown', active, { capture: true });
    return () => {
      window.removeEventListener('keydown', active, { capture: true });
      window.removeEventListener('pointerdown', active, { capture: true });
      detach();
    };
  }, [player, annotation]);

  // Telemetry: when the first frame shows, and each play, pause and change of speed.
  useEffect(() => {
    if (!player) return;
    const openedAt = performance.now();
    let ready = false;
    let playing = false;
    let rate = 0;
    return player.subscribe(() => {
      const s = player.snapshot;
      if (!ready && s.frame >= 0) {
        ready = true;
        annotation.log('media_ready', { load_ms: Math.round(performance.now() - openedAt) });
      }
      const now = s.skimming ? SKIM_SPEED : s.speed;
      if (s.playing === playing && (now === rate || !s.playing)) return;
      const action = s.playing === playing ? 'rate' : s.playing ? 'play' : 'pause';
      playing = s.playing;
      rate = now;
      annotation.notePlayback(playing, rate, action);
    });
  }, [player, annotation]);

  // Remember the place whenever the video stops, to reopen there.
  useEffect(() => {
    if (!player) return;
    return player.subscribe(() => {
      if (!player.snapshot.playing && player.frame >= 0) {
        writeResumeFrame(recordingId, player.frame);
      }
    });
  }, [player, recordingId]);

  return { player, setVideo };
}
