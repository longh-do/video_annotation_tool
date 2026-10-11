/**
 * The local server: API, media and the UI on one port.
 *
 *   pnpm dev     UI through Vite, with hot reload
 *   pnpm start   UI from dist/ (run `pnpm build` first)
 *
 * Options: --port 5173  --catalog derived/catalog.json  --annotations annotations
 *          --telemetry telemetry/events.jsonl  --annotator local  --dev
 *
 * The port is fixed on purpose: the browser keeps its crash-recovery journal per origin.
 */
import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { AnnotationStore } from './annotations.ts';
import { createApi } from './api.ts';
import { readCatalog } from './catalog.ts';
import { sendJson } from './http.ts';
import { sendFile } from './media.ts';
import { TelemetryLog } from './telemetry.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '5173' },
    catalog: { type: 'string', default: 'derived/catalog.json' },
    annotations: { type: 'string', default: 'annotations' },
    telemetry: { type: 'string', default: 'telemetry/events.jsonl' },
    annotator: { type: 'string', default: 'local' },
    dev: { type: 'boolean', default: false },
  },
});

const catalog = await readCatalog(values.catalog).catch((error: NodeJS.ErrnoException) => {
  const hint = error.code === 'ENOENT' ? ' Run `pnpm ingest <data folder>` first.' : '';
  console.error(`Can't read the catalog ${values.catalog}: ${error.message}.${hint}`);
  process.exit(1);
});
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

const api = createApi({
  catalog,
  store: new AnnotationStore(values.annotations),
  telemetry: new TelemetryLog(values.telemetry),
  annotatorId: values.annotator,
  toolVersion: packageJson.version,
});

const server = createServer((req, res) => {
  handle(req, res).catch((error: NodeJS.ErrnoException) => {
    // Seeking cancels in-flight video requests; that is normal, not a server error.
    if (error.code === 'ERR_STREAM_PREMATURE_CLOSE' || error.code === 'ECONNRESET') return;
    console.error(error);
    if (res.headersSent) res.destroy();
    else sendJson(res, 500, { error: 'internal server error' });
  });
});

const ui = values.dev ? await viteUi() : staticUi(resolve('dist'));

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!(await api(req, res))) await ui(req, res);
}

/** Development: Vite serves the UI from src/web with hot reload, on this same server. */
async function viteUi() {
  const { createServer: createVite } = await import('vite');
  const vite = await createVite({
    configFile: resolve('vite.config.ts'),
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  return (req: IncomingMessage, res: ServerResponse) =>
    new Promise<void>((done) => vite.middlewares(req, res, done));
}

/** Production: the built UI from dist/, with every unknown path falling back to index.html. */
function staticUi(root: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const path = normalize(join(root, new URL(req.url ?? '/', 'http://localhost').pathname));
    const file =
      path.startsWith(root + sep) && (await isFile(path)) ? path : join(root, 'index.html');
    if (!(await isFile(file))) {
      sendJson(res, 404, { error: 'UI not built: run `pnpm build`, or use `pnpm dev`' });
      return;
    }
    await sendFile(
      req,
      res,
      file,
      file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000',
    );
  };
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

server.listen(Number(values.port), '127.0.0.1', () => {
  const count = catalog.recordings.length;
  console.log(`Annotating ${count} recording(s) at http://127.0.0.1:${values.port}`);
});
