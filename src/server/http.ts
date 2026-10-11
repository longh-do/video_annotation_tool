/** Small HTTP helpers shared by the handlers. */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Thrown by handlers; the server turns it into a JSON error response. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  constructor(
    status: number,
    message: string,
    body: unknown = { error: message },
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

/**
 * Whether a request was addressed to this machine by name. A web page on another site can point
 * its own name at 127.0.0.1 (DNS rebinding), but its requests still carry that name in Host.
 */
export function isLocalHost(host: string | undefined): boolean {
  const name = /^(.*?)(:\d+)?$/.exec(host ?? '')?.[1];
  return name === '127.0.0.1' || name === 'localhost';
}

/**
 * Reads a JSON request body, refusing anything over `limitBytes`. The body must be sent as JSON: a
 * page on another site can have the browser send text/plain here without asking, but not JSON.
 */
export async function readJson(req: IncomingMessage, limitBytes = 2_000_000): Promise<unknown> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'send the body with Content-Type: application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) {
      // The rest of the body is never read, so this connection can't carry another request.
      throw new HttpError(413, 'request body too large', undefined, { Connection: 'close' });
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}
