/**
 * Find, check and catalog the recordings under a data folder, with the task guides that say what
 * to keep in them.
 *
 *   pnpm ingest <data folder> [--tasks <folder>] [--out derived]
 *
 * Task guides, one Markdown file per task (see docs/task-guide-template.md), are read from this
 * repository's `tasks/` folder; --tasks reads them from another folder instead. Without any,
 * annotators see no task guide. Exits non-zero if a recording was rejected or none was found.
 */
import { stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { findMediaTools } from '../src/server/ffmpeg.ts';
import { ingest } from '../src/server/ingest.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tasks: { type: 'string' },
    out: { type: 'string', default: 'derived' },
  },
});

const dataDir = positionals[0];
if (!dataDir) {
  console.error('usage: pnpm ingest <data folder> [--tasks <folder>] [--out <folder>]');
  process.exit(2);
}

if (values.tasks !== undefined && !(await isFolder(values.tasks))) {
  console.error(`--tasks ${values.tasks} is not a folder`);
  process.exit(2);
}
const inRepo = join(import.meta.dirname, '..', 'tasks');
const tasksDir = values.tasks ?? ((await isFolder(inRepo)) ? inRepo : null);
if (tasksDir === null) {
  console.warn(
    `! no task guides: put them in ${relative(process.cwd(), inRepo)} or pass --tasks <folder>; annotators will see none`,
  );
} else {
  console.log(`task guides from ${relative(process.cwd(), tasksDir) || '.'}`);
}
const tools = await findMediaTools();
if (!tools) console.warn('! ffmpeg not found: skipping the video timestamp check and thumbnails');
const { catalog, inspections, taskWarnings } = await ingest({
  dataDir,
  outDir: values.out,
  tasksDir,
  tools,
});

for (const [id, guide] of Object.entries(catalog.tasks)) {
  const covered = catalog.recordings.filter((recording) => recording.task === id).length;
  console.log(`✓ task ${id}  ${guide.title} · ${covered} recording(s)`);
}
for (const warning of taskWarnings) console.log(`! ${warning}`);

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

async function isFolder(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}
