/**
 * The web server for the end-to-end tests: the synthetic recordings, freshly ingested, served by
 * the real server on E2E_PORT with no annotations or telemetry left from earlier runs.
 *
 *   node tests/e2e/serve.ts
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { findMediaTools } from '../../src/server/ffmpeg.ts';
import { ingest } from '../../src/server/ingest.ts';
import { E2E_PORT } from './port.ts';
import { E2E_DIR, writeSyntheticRecordings } from './synthetic.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const DATA = join(E2E_DIR, 'data');
const TASKS = join(E2E_DIR, 'tasks');
const DERIVED = join(E2E_DIR, 'derived');
const ANNOTATIONS = join(E2E_DIR, 'annotations');
const TELEMETRY = join(E2E_DIR, 'telemetry');

await writeSyntheticRecordings(DATA);

// One task guide, with a link to a moment; synthetic-e is left without a task on purpose.
const guide = [
  '---',
  'recordings: synthetic-a, synthetic-b, synthetic-c, synthetic-d',
  '---',
  '',
  '# Example task for the tests',
  '',
  'This guide only exists for the end-to-end tests.',
  '',
  'It links to [a moment in synthetic-c](#synthetic-c/30).',
];
await mkdir(TASKS, { recursive: true });
await writeFile(join(TASKS, 'synthetic.md'), `${guide.join('\n')}\n`);

const { inspections } = await ingest({
  dataDir: DATA,
  outDir: DERIVED,
  tasksDir: TASKS,
  tools: await findMediaTools(),
});
const rejected = inspections.filter((inspection) => inspection.recording === null);
for (const { manifestPath, errors } of rejected) {
  console.error(`✗ ${manifestPath}\n    ${errors.join('\n    ')}`);
}
if (rejected.length > 0) process.exit(1);

await rm(ANNOTATIONS, { recursive: true, force: true });
await rm(TELEMETRY, { recursive: true, force: true });

const server = spawn(
  process.execPath,
  [
    ...[join(ROOT, 'src/server/main.ts'), '--dev', '--port', String(E2E_PORT)],
    ...['--catalog', join(DERIVED, 'catalog.json'), '--annotations', ANNOTATIONS],
    ...['--telemetry', join(TELEMETRY, 'events.jsonl')],
  ],
  // The server looks for vite.config.ts in its working directory.
  { cwd: ROOT, stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 1));
