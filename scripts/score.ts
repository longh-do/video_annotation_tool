/**
 * Compare annotations with gold annotations of the same recordings.
 *
 *   pnpm score <gold folder> <annotations folder>
 *     [--catalog derived/catalog.json] [--telemetry telemetry/events.jsonl] [--json]
 *
 * Gold files are contract files (<recording_id>.json), e.g. a lead's careful pass in the tool.
 * Exits non-zero if a folder is missing or a file breaks the contract (it is named in the report).
 */
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { readCatalog } from '../src/server/catalog.ts';
import { formatReport, scoreFolders } from '../src/server/score-report.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    catalog: { type: 'string', default: 'derived/catalog.json' },
    telemetry: { type: 'string', default: 'telemetry/events.jsonl' },
    json: { type: 'boolean', default: false },
  },
});

const [goldDir, testDir] = positionals;
if (!goldDir || !testDir) {
  console.error(
    'usage: pnpm score <gold folder> <annotations folder> [--catalog <file>] [--telemetry <file>] [--json]',
  );
  process.exit(2);
}
for (const dir of [goldDir, testDir]) {
  if (!(await isFolder(dir))) {
    console.error(`${dir} is not a folder`);
    process.exit(2);
  }
}

const catalog = await readCatalog(values.catalog);
const telemetry = existsSync(values.telemetry) ? values.telemetry : null;
const report = await scoreFolders(goldDir, testDir, catalog, telemetry);
process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
process.exitCode = report.invalid.length > 0 ? 1 : 0;

async function isFolder(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}
