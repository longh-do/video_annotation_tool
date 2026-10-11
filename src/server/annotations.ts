/**
 * Saved annotations on disk:
 *
 *   annotations/<recording_id>.json        the contract file, exactly as specified
 *   annotations/<recording_id>.meta.json   the sidecar (boundaries, provenance, revision, …)
 *   annotations/.history/<recording_id>/<revision>.json   each saved revision: both, together
 *
 * Saves use optimistic concurrency: the client names the revision it edited, and a save based on
 * an older one is refused, so a second tab can never silently overwrite the first. Every file is
 * written to a temporary name, flushed and renamed into place. A revision's history record is
 * written first and holds both files, so it is what loads read: a crash between the later writes
 * can't pair one revision's contract file with another's sidecar, and the next load finishes the
 * save by rewriting the files that are behind the record.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AnnotationFile, Sidecar, SidecarDraft } from '../core/annotation.ts';
import type { SavedAnnotation } from '../core/api-types.ts';
import { isSafeRecordingId } from './catalog.ts';

/** What the server vouches for on every save, whatever the client sent. */
export interface Stamp {
  readonly annotatorId: string;
  readonly guidelineVersion: string | null;
  readonly toolVersion: string;
}

export class RevisionConflict extends Error {
  readonly current: number;
  constructor(current: number) {
    super(`the annotation is at revision ${current}`);
    this.current = current;
  }
}

interface HistoryRecord {
  readonly annotation: AnnotationFile;
  readonly sidecar: Sidecar;
}

export class AnnotationStore {
  readonly #dir: string;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.#dir = dir;
  }

  /**
   * The newest saved revision, or a contract file that something else put there (it has no
   * sidecar); null when there is neither.
   */
  load(id: string): Promise<SavedAnnotation | null> {
    return this.#serialize(id, async () => {
      const revision = await this.#currentRevision(id);
      const sidecar = await readJsonFile<Sidecar>(this.#path(id, '.meta.json'));
      if (sidecar && revision > 0) {
        const record = await readJsonFile<HistoryRecord>(this.#historyPath(id, revision));
        if (record) {
          await this.#rollForward(id, record, sidecar);
          return { revision, ...record };
        }
      }
      const annotation = await readJsonFile<AnnotationFile>(this.#path(id, '.json'));
      return annotation && { revision, annotation, sidecar: null };
    });
  }

  /** The revision a save must name: 0 before the first save. */
  revision(id: string): Promise<number> {
    return this.#serialize(id, () => this.#currentRevision(id));
  }

  /** Saves a new revision on top of `baseRevision`; throws RevisionConflict if that is stale. */
  save(
    id: string,
    baseRevision: number,
    annotation: AnnotationFile,
    draft: SidecarDraft,
    stamp: Stamp,
  ): Promise<Sidecar> {
    return this.#serialize(id, async () => {
      const current = await this.#currentRevision(id);
      if (current !== baseRevision) throw new RevisionConflict(current);
      const sidecar: Sidecar = {
        ...draft,
        revision: current + 1,
        saved_at: new Date().toISOString(),
        annotator_id: stamp.annotatorId,
        guideline_version: stamp.guidelineVersion,
        tool_version: stamp.toolVersion,
      };
      await writeAtomic(this.#historyPath(id, sidecar.revision), { annotation, sidecar });
      await writeAtomic(this.#path(id, '.meta.json'), sidecar);
      await writeAtomic(this.#path(id, '.json'), annotation);
      return sidecar;
    });
  }

  /**
   * Finishes a save that stopped after its history record (the server crashed, say): the sidecar
   * and the contract file, in the order a save writes them, if they are behind the record.
   */
  async #rollForward(id: string, record: HistoryRecord, sidecar: Sidecar): Promise<void> {
    if (sidecar.revision !== record.sidecar.revision) {
      await writeAtomic(this.#path(id, '.meta.json'), record.sidecar);
    }
    const contract = await readJsonFile(this.#path(id, '.json')).catch(() => null);
    if (!isDeepStrictEqual(contract, record.annotation)) {
      await writeAtomic(this.#path(id, '.json'), record.annotation);
    }
  }

  /** The newest revision in the history; it outlives a deleted or replaced sidecar. */
  async #currentRevision(id: string): Promise<number> {
    const names = await readdir(dirname(this.#historyPath(id, 0))).catch(() => []);
    const revisions = names.map((name) => /^(\d+)\.json$/.exec(name)?.[1] ?? '0').map(Number);
    return Math.max(0, ...revisions);
  }

  #path(id: string, suffix: string): string {
    return join(this.#dir, `${safe(id)}${suffix}`);
  }

  #historyPath(id: string, revision: number): string {
    return join(this.#dir, '.history', safe(id), `${revision}.json`);
  }

  /** One operation at a time per recording, so a load never sees half a save. */
  #serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
    const result = (this.#queues.get(id) ?? Promise.resolve()).then(task);
    this.#queues.set(
      id,
      result.catch(() => {}),
    );
    return result;
  }
}

function safe(id: string): string {
  if (!isSafeRecordingId(id)) throw new Error(`unsafe recording id "${id}"`);
  return id;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'w');
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  // Flush the directory too, so the rename itself survives a crash. Windows can't open a folder
  // to flush it, so there the rename is as durable as the file system makes it.
  if (process.platform === 'win32') return;
  const dir = await open(dirname(path), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
