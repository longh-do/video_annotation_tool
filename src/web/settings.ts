/**
 * Per-annotator conveniences kept in the browser: speed, sound, the side panel's width and the
 * camera shown big stick between recordings, and each recording reopens where it was left.
 * Storage can be unavailable (private windows, blocked site data); the defaults then apply. None
 * of this makes a new revision; where a recording was left is also in its saved sidecar
 * (`resume`), which the next save brings up to date.
 */
type Settings = { speed: number; sound: boolean; panelWidth: number; mainCamera: string };

export function readSetting<K extends keyof Settings>(key: K, fallback: Settings[K]): Settings[K] {
  return read(`setting.${key}`) ?? fallback;
}

export function writeSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  write(`setting.${key}`, value);
}

/** The frame a recording was last left at, if known. */
export function readResumeFrame(recordingId: string): number | null {
  return read(`resume.${recordingId}`);
}

export function writeResumeFrame(recordingId: string, frame: number): void {
  write(`resume.${recordingId}`, frame);
}

function read<T>(key: string): T | null {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? null : (JSON.parse(stored) as T);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not stored: it lasts for this page only.
  }
}
