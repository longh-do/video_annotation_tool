/**
 * Find, check and catalog the recordings under a data folder.
 *
 *   pnpm ingest <data folder> [--guideline docs/guidelines-example.md] [--out derived]
 *
 * Exits non-zero if a recording was rejected or none was found.
 */
import { access } from 'node:fs/promises';
import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { findMediaTools } from '../src/server/ffmpeg.ts';
import { ingest } from '../src/server/ingest.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    guideline: { type: 'string', default: 'docs/guidelines-example.md' },
    out: { type: 'string', default: 'derived' },
  },
});

const dataDir = positionals[0];
if (!dataDir) {
  console.error('usage: pnpm ingest <data folder> [--guideline <file.md>] [--out <folder>]');
  process.exit(2);
}

const guidelinePath = await access(values.guideline).then(
  () => values.guideline,
  () => {
    console.warn(`! guideline ${values.guideline} not found; annotators will see none`);
    return null;
  },
);
const tools = await findMediaTools();
if (!tools) console.warn('! ffmpeg not found: skipping the video timestamp check and thumbnails');
const { catalog, inspections } = await ingest({
  dataDir,
  outDir: values.out,
  guidelinePath,
  tools,
});

for (const { recording, manifestPath, errors, warnings } of inspections) {
  if (recording) {
    const reference = recording.cameras[0];
    const thumbs = recording.thumbnails
      ? ` · ${recording.thumbnails.frames.length} thumbnails`
      : '';
    console.log(
      `✓ ${recording.id}  ${recording.durationS.toFixed(1)} s · ${recording.cameras.length} cameras · ` +
        `${reference?.frameCount} reference frames${thumbs}`,
    );
  } else {
    console.log(`✗ ${relative(process.cwd(), manifestPath)}`);
  }
  for (const error of errors) console.log(`    × ${error}`);
  for (const warning of warnings) console.log(`    ! ${warning}`);
}

const rejected = inspections.length - catalog.recordings.length;
console.log(
  `\n${catalog.recordings.length} recording(s) ready, ${rejected} rejected → ${values.out}/catalog.json`,
);
process.exit(rejected > 0 || catalog.recordings.length === 0 ? 1 : 0);
