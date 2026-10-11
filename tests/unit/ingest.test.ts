import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { MediaTools } from '../../src/server/ffmpeg.ts';
import { ingest } from '../../src/server/ingest.ts';
import { tempDir, type WrittenRecording, writeRecording } from './fixtures.ts';

/** Stands in for ffprobe/ffmpeg: reports the fixture's true timestamps. */
function fakeTools(recordings: WrittenRecording[]): MediaTools {
  const pts = new Map(recordings.flatMap((r) => [...r.pts]));
  return {
    probe: async (video) => ({ timeBase: '1/1000000', bFrames: false, pts: pts.get(video) ?? [] }),
    sprites: async (video, outDir) => {
      const sheet = join(outDir, 'thumbs-01.jpg');
      await writeFile(sheet, 'jpeg');
      return { sheetPaths: [sheet], pts: (pts.get(video) ?? []).filter((_, i) => i % 20 === 0) };
    },
  };
}

async function run(setup: (root: string) => Promise<WrittenRecording[]>, withTools = true) {
  const root = await tempDir();
  const written = await setup(root);
  const outDir = join(root, 'derived');
  const result = await ingest({
    dataDir: root,
    outDir,
    guidelinePath: null,
    tools: withTools ? fakeTools(written) : null,
  });
  return { ...result, root, outDir, written };
}

describe('ingest', () => {
  test('finds recordings in both folder layouts, in path order, reference camera first', async () => {
    const { catalog, outDir, inspections } = await run(async (root) => [
      await writeRecording(root, { id: '02-split', layout: 'split' }),
      await writeRecording(root, { id: '01-together' }),
    ]);
    expect(inspections.flatMap((i) => i.errors)).toEqual([]);
    expect(catalog.recordings.map((r) => r.id)).toEqual(['01-together', '02-split']);
    const split = catalog.recordings[1]!;
    expect(split.cameras.map((c) => c.label)).toEqual(['head', 'left', 'right']);
    expect(split.cameras[0]).toMatchObject({ video: 'videos/head-0000.mp4', frameCount: 50 });
    expect(split.cameras[0]?.videoPath).toMatch(/02-split\/videos\/head-0000\.mp4$/);
    expect(split.cameras[0]?.framesPath).toMatch(/02-split\/annotation-data\/head-frames\.csv$/);
    expect(split.thumbnails?.frames).toEqual([0, 20, 40]);
    expect(JSON.parse(await readFile(join(outDir, 'catalog.json'), 'utf8'))).toEqual(catalog);
  });

  test('warns when an annotation template names another recording, and trusts the manifest', async () => {
    const { catalog } = await run(async (root) => [
      await writeRecording(root, { id: 'b', templateId: 'a' }),
    ]);
    expect(catalog.recordings[0]?.warnings).toEqual([
      'annotation-template.json names a; using b from manifest.json',
    ]);
  });

  test('rejects a frames CSV that disagrees with the manifest', async () => {
    const { catalog, inspections } = await run(async (root) => {
      const r = await writeRecording(root, { id: 'r' });
      const manifest = JSON.parse(await readFile(r.manifestPath, 'utf8'));
      manifest.cameras['umi.left.camera.enc'][0].frames = 49;
      await writeFile(r.manifestPath, JSON.stringify(manifest));
      return [r];
    });
    expect(catalog.recordings).toEqual([]);
    expect(inspections[0]?.errors).toEqual([
      'umi.left.camera.enc: frames CSV has 50 frames, the manifest 49',
    ]);
  });

  test('rejects a frames CSV that disagrees with the video timestamps', async () => {
    const { inspections } = await run(async (root) => {
      const r = await writeRecording(root, { id: 'r' });
      const [video, pts] = [...r.pts][0]!;
      return [{ ...r, pts: new Map([[video, pts.map((p, i) => (i === 7 ? p + 1 : p))]]) }];
    });
    expect(inspections[0]?.errors.join()).toMatch(/frame 7 is at \d+ µs in the video/);
  });

  test('rejects a recording whose video is missing, or whose camera has several parts', async () => {
    const { inspections } = await run(async (root) => {
      const missing = await writeRecording(root, { id: 'missing' });
      await rename(join(root, 'missing', 'videos', 'right-0000.mp4'), join(root, 'elsewhere.mp4'));
      const parts = await writeRecording(root, { id: 'parts' });
      const manifest = JSON.parse(await readFile(parts.manifestPath, 'utf8'));
      const head = manifest.cameras['umi.head.camera.enc'];
      head.push({ ...head[0], file: 'videos/head-0001.mp4' });
      await writeFile(parts.manifestPath, JSON.stringify(manifest));
      return [missing, parts];
    });
    expect(inspections.map((i) => i.errors)).toEqual([
      [
        'umi.right.camera.enc: videos/right-0000.mp4 not found next to the manifest or one folder up',
      ],
      ['umi.head.camera.enc: 2 video parts; only single-part cameras are supported'],
    ]);
  });

  test('rejects a second recording with the same id', async () => {
    const { catalog, inspections } = await run(async (root) => {
      const first = await writeRecording(root, { id: 'same' });
      return [first, await writeRecording(join(root, 'copy'), { id: 'same' })];
    });
    expect(catalog.recordings).toHaveLength(1);
    expect(inspections[1]?.errors).toEqual(['duplicate recording same']);
  });

  test('still validates everything else without ffmpeg', async () => {
    const { catalog } = await run(async (root) => [await writeRecording(root, { id: 'r' })], false);
    expect(catalog.recordings[0]).toMatchObject({ thumbnails: null, warnings: [] });
  });

  test('rejects a recording id that is not a plain name, without touching other folders', async () => {
    const { catalog, inspections, outDir } = await run(async (root) => {
      const r = await writeRecording(root, { id: 'r' });
      const manifest = JSON.parse(await readFile(r.manifestPath, 'utf8'));
      await writeFile(r.manifestPath, JSON.stringify({ ...manifest, recording_id: '../victim' }));
      await mkdir(join(root, 'derived', '..', 'victim'), { recursive: true });
      await writeFile(join(root, 'victim', 'keep.txt'), 'still here');
      return [r];
    });
    expect(catalog.recordings).toEqual([]);
    expect(inspections[0]?.errors.join()).toMatch(
      /recording_id "..\/victim" is missing or not a plain name/,
    );
    expect(await readFile(join(outDir, '..', 'victim', 'keep.txt'), 'utf8')).toBe('still here');
  });

  test('one broken folder does not stop the others', async () => {
    const { catalog, inspections } = await run(async (root) => {
      const broken = await writeRecording(root, { id: 'a-broken' });
      await writeFile(broken.manifestPath, '{ "recording_id": "a-broken", "cameras": ');
      const parts = await writeRecording(root, { id: 'b-no-file' });
      const manifest = JSON.parse(await readFile(parts.manifestPath, 'utf8'));
      delete manifest.cameras['umi.left.camera.enc'][0].file;
      await writeFile(parts.manifestPath, JSON.stringify(manifest));
      return [broken, parts, await writeRecording(root, { id: 'c-fine' })];
    });
    expect(catalog.recordings.map((r) => r.id)).toEqual(['c-fine']);
    expect(inspections[0]?.errors.join()).toMatch(/JSON/);
    expect(inspections[1]?.errors).toEqual([
      'manifest.json: camera umi.left.camera.enc has malformed video parts',
    ]);
  });

  test('warns about an annotation template that is not valid JSON', async () => {
    const { catalog } = await run(async (root) => {
      const r = await writeRecording(root, { id: 'r' });
      await writeFile(join(root, 'r', 'annotation-template.json'), '{ not json');
      return [r];
    });
    expect(catalog.recordings[0]?.warnings).toEqual([
      'annotation-template.json is not valid JSON; ignored it',
    ]);
  });

  test("a rejected duplicate leaves the accepted recording's thumbnails alone", async () => {
    const { catalog, outDir } = await run(async (root) => {
      const first = await writeRecording(root, { id: 'same' });
      return [first, await writeRecording(join(root, 'zz-copy'), { id: 'same' })];
    });
    const sheet = catalog.recordings[0]?.thumbnails?.sheetPaths[0] ?? '';
    expect(sheet.startsWith(join(outDir, 'same'))).toBe(true);
    expect(await readdir(join(outDir, 'same'))).toEqual(['thumbs-01.jpg']);
  });

  test('keeps a recording whose thumbnails fail, with a warning', async () => {
    const root = await tempDir();
    const written = await writeRecording(root, { id: 'r' });
    const tools = fakeTools([written]);
    const { catalog } = await ingest({
      dataDir: root,
      outDir: join(root, 'derived'),
      guidelinePath: null,
      tools: { ...tools, sprites: async () => Promise.reject(new Error('ffmpeg crashed')) },
    });
    expect(catalog.recordings[0]).toMatchObject({
      thumbnails: null,
      warnings: ['no thumbnails: ffmpeg crashed'],
    });
    expect((await readdir(join(root, 'derived'))).filter((name) => name.startsWith('.'))).toEqual(
      [],
    );
  });

  test('stamps the guideline with its title and a content hash', async () => {
    const root = await tempDir();
    await writeRecording(root, { id: 'r' });
    const guidelinePath = join(root, 'guide.md');
    await writeFile(guidelinePath, '# Folding guideline\n\nKeep from first touch.\n');
    const { catalog } = await ingest({
      dataDir: root,
      outDir: join(root, 'out'),
      guidelinePath,
      tools: null,
    });
    expect(catalog.guideline).toMatchObject({ title: 'Folding guideline', path: guidelinePath });
    expect(catalog.guideline?.version).toMatch(/^sha256:[0-9a-f]{12}$/);
  });
});
