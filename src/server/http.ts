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

/** Reads a JSON request body, refusing anything over `limitBytes`. */
export async function readJson(req: IncomingMessage, limitBytes = 2_000_000): Promise<unknown> {
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
