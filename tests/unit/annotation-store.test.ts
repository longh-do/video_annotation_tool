import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { AnnotationFile, SidecarDraft } from '../../src/core/annotation.ts';
import { AnnotationStore, RevisionConflict, type Stamp } from '../../src/server/annotations.ts';
import { tempDir } from './fixtures.ts';

const annotation: AnnotationFile = {
  recording_id: 'rec',
  reference_video: 'videos/head-0000.mp4',
  status: 'not_reviewed',
  keep_intervals: [],
  notes: '',
};

const draft: SidecarDraft = {
  schema_version: 1,
  frame_count: 10,
  boundaries: [],
  review_reason: null,
  resume: { frame: 0, playback_rate: 2 },
  effort: { active_ms: 0, wall_ms: 0, edits: 0, undos: 0 },
};

const stamp: Stamp = { annotatorId: 'a1', guidelineVersion: 'sha256:abc', toolVersion: '0.1.0' };

describe('AnnotationStore', () => {
  test('saves the contract file, the sidecar and a history record per revision', async () => {
    const dir = await tempDir();
    const store = new AnnotationStore(dir);
    expect(await store.load('rec')).toBeNull();
    expect(await store.revision('rec')).toBe(0);

    expect((await store.save('rec', 0, annotation, draft, stamp)).revision).toBe(1);
    const complete = { ...annotation, status: 'complete' as const };
    expect((await store.save('rec', 1, complete, draft, stamp)).revision).toBe(2);

    expect(JSON.parse(await readFile(join(dir, 'rec.json'), 'utf8'))).toEqual(complete);
    const saved = await store.load('rec');
    expect(saved).toMatchObject({ revision: 2, annotation: complete });
    expect(saved?.sidecar).toMatchObject({
      revision: 2,
      annotator_id: 'a1',
      guideline_version: 'sha256:abc',
    });
    expect((await readdir(join(dir, '.history', 'rec'))).sort()).toEqual(['1.json', '2.json']);
    // No temporary files are left behind.
    expect((await readdir(dir)).sort()).toEqual(['.history', 'rec.json', 'rec.meta.json']);
  });

  test('refuses a save based on a stale revision', async () => {
    const store = new AnnotationStore(await tempDir());
    await store.save('rec', 0, annotation, draft, stamp);
    await expect(store.save('rec', 0, annotation, draft, stamp)).rejects.toEqual(
      new RevisionConflict(1),
    );
  });

  test('two saves racing on the same revision: exactly one wins', async () => {
    const store = new AnnotationStore(await tempDir());
    const results = await Promise.allSettled([
      store.save('rec', 0, annotation, draft, stamp),
      store.save('rec', 0, annotation, draft, stamp),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await store.revision('rec')).toBe(1);
  });

  test('a load racing saves always sees one revision: contract and sidecar together', async () => {
    const store = new AnnotationStore(await tempDir());
    const saves: Promise<unknown>[] = [];
    const loads: Promise<unknown>[] = [];
    for (let r = 0; r < 20; r++) {
      saves.push(store.save('rec', r, { ...annotation, notes: `rev ${r + 1}` }, draft, stamp));
      loads.push(store.load('rec'));
    }
    await Promise.all(saves);
    for (const saved of (await Promise.all(loads)) as Awaited<
      ReturnType<AnnotationStore['load']>
    >[]) {
      if (saved) expect(saved.annotation.notes).toBe(`rev ${saved.revision}`);
    }
  });

  test('a contract file without a sidecar loads as is, and history numbering carries on', async () => {
    const dir = await tempDir();
    const store = new AnnotationStore(dir);
    await store.save('rec', 0, annotation, draft, stamp);
    await rm(join(dir, 'rec.meta.json'));
    const gold = { ...annotation, status: 'complete' as const, notes: 'gold' };
    await writeFile(join(dir, 'rec.json'), JSON.stringify(gold));
    expect(await store.load('rec')).toEqual({ revision: 1, annotation: gold, sidecar: null });
    expect((await store.save('rec', 1, annotation, draft, stamp)).revision).toBe(2);
    expect((await readdir(join(dir, '.history', 'rec'))).sort()).toEqual(['1.json', '2.json']);
  });

  test('a save cut short after its history record is finished on the next load', async () => {
    const dir = await tempDir();
    const store = new AnnotationStore(dir);
    const files = ['rec.json', 'rec.meta.json'];
    const read = (name: string) => readFile(join(dir, name), 'utf8');
    await store.save('rec', 0, { ...annotation, notes: 'one' }, draft, stamp);
    const one = await Promise.all(files.map(read));
    await store.save('rec', 1, { ...annotation, notes: 'two' }, draft, stamp);
    const two = await Promise.all(files.map(read));

    // Stopped after the history record: both files are still revision 1's.
    await Promise.all(files.map((name, i) => writeFile(join(dir, name), one[i] ?? '')));
    expect(await new AnnotationStore(dir).load('rec')).toMatchObject({
      revision: 2,
      annotation: { notes: 'two' },
    });
    expect(await Promise.all(files.map(read))).toEqual(two);

    // Stopped after the sidecar: only the contract file is behind.
    await writeFile(join(dir, 'rec.json'), one[0] ?? '');
    await new AnnotationStore(dir).load('rec');
    expect(await Promise.all(files.map(read))).toEqual(two);
  });

  test('rejects ids that could escape the folder', async () => {
    const store = new AnnotationStore(await tempDir());
    await expect(store.load('../etc')).rejects.toThrow(/unsafe recording id/);
  });
});
