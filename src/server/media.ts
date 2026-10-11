/**
 * Static files with HTTP byte ranges. A browser can only seek in a video if the server answers
 * `Range` requests with 206 Partial Content; `python3 -m http.server` never does, so every seek
 * there snaps back to the start.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.csv': 'text/csv; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * The byte range a `Range` header asks for. Null means "send the whole file": the header is
 * absent, malformed or asks for several ranges, all of which a server may answer in full.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | null | 'unsatisfiable' {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    return suffix === 0 || size === 0
      ? 'unsatisfiable'
      : { start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (last !== '' && Number(last) < start) return null;
  return start >= size ? 'unsatisfiable' : { start, end };
}

export async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  cacheControl = 'no-store',
): Promise<void> {
  const { size, mtime } = await stat(path);
  const range = parseRange(req.headers.range, size);
  const headers: Record<string, string | number> = {
    'Content-Type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Last-Modified': mtime.toUTCString(),
    'Cache-Control': cacheControl,
  };
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  await pipeline(createReadStream(path, { start, end }), res);
}
