/**
 * A soft tick for every mark that changes the timeline: higher for keep, lower for cut. The
 * recordings are silent, so the sound confirms a mark without taking the eyes off the video.
 */
let context: AudioContext | null = null;

export function tick(kind: 'keep' | 'cut', muted: boolean): void {
  if (muted) return;
  context ??= new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = kind === 'keep' ? 880 : 440;
  gain.gain.setValueAtTime(0.08, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.06);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.06);
}
