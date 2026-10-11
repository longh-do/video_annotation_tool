/**
 * The app's server for a script (pnpm perf): the production build on a port of its own
 * and a scratch annotations folder, so real work is never touched. It refuses a port already in
 * use, notices a server that dies while starting, and `stop` always cleans up.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface LocalServer {
  readonly url: string;
  stop(): Promise<void>;
}

export async function startServer(port: number, catalog: string): Promise<LocalServer> {
  if (!existsSync('dist/index.html')) throw new Error('run pnpm build first: this uses the build');
  const url = `http://127.0.0.1:${port}`;
  if (await answers(url)) throw new Error(`port ${port} is in use; stop what runs there first`);
  const work = await mkdtemp(join(tmpdir(), 'annotator-'));
  const child = spawn(
    process.execPath,
    [
      ...[resolve('src/server/main.ts'), '--port', String(port), '--catalog', catalog],
      ...['--annotations', join(work, 'annotations'), '--telemetry', join(work, 'events.jsonl')],
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const exited = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
    await rm(work, { recursive: true, force: true });
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error('the server stopped while starting');
      if (await answers(url)) return { url, stop };
      await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error('the server did not start');
  } catch (error) {
    await stop();
    throw error;
  }
}

function answers(url: string): Promise<boolean> {
  return fetch(`${url}/api/queue`).then(
    (response) => response.ok,
    () => false,
  );
}
