/** File helpers shared by the annotation store and the task guides. */
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Writes a file under a temporary name, flushes it and renames it into place, so a crash leaves
 * the old file or the new one, never part of one.
 */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'w');
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  // Flush the directory too, so the rename itself survives a crash.
  const dir = await open(dirname(path), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/** Runs operations one at a time per key, in the order they were asked for. */
export function oneAtATime() {
  const queues = new Map<string, Promise<unknown>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const result = (queues.get(key) ?? Promise.resolve()).then(task);
    queues.set(
      key,
      result.catch(() => {}),
    );
    return result;
  };
}
