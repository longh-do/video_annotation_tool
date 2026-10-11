import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SavePayload } from '../../../src/core/api-types.ts';
import { Saver } from '../../../src/web/saver.ts';

const payload = (notes: string) => ({ annotation: { notes } }) as unknown as SavePayload;

interface Call {
  readonly revision: string;
  readonly notes: string;
  readonly keepalive: boolean;
}

/** A fake server: records each PUT and answers with the next scripted response. */
function server(...responses: (number | 'offline')[]) {
  const calls: Call[] = [];
  let revision = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { annotation: { notes: string } };
      const headers = init.headers as Record<string, string>;
      calls.push({
        revision: headers['If-Match'] ?? '',
        notes: body.annotation.notes,
        keepalive: init.keepalive === true,
      });
      const status = responses.shift() ?? 200;
      if (status === 'offline') throw new TypeError('Failed to fetch');
      if (status === 200) revision++;
      const json = status === 200 ? { revision, savedAt: 'now' } : { problems: ['bad'], revision };
      return new Response(JSON.stringify(json), { status });
    }),
  );
  return calls;
}

describe('Saver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('sends the newest version once changes pause, on top of the last revision', async () => {
    const calls = server();
    const saver = new Saver('rec', 3, null);
    saver.save(payload('first'));
    saver.save(payload('second'));
    expect(saver.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual([{ revision: '"3"', notes: 'second', keepalive: false }]);
    expect(saver.status.kind).toBe('saved');
    expect(saver.dirty).toBe(false);
    saver.save(payload('third'));
    await vi.advanceTimersByTimeAsync(300);
    expect(calls.at(-1)).toMatchObject({ revision: '"1"', notes: 'third' });
  });

  test('a conflict stops saving for good, so nothing is silently overwritten', async () => {
    const calls = server(412);
    const saver = new Saver('rec', 0, null);
    saver.save(payload('mine'));
    await vi.advanceTimersByTimeAsync(300);
    expect(saver.status.kind).toBe('conflict');
    expect(saver.stopped).toBe(true);
    saver.save(payload('more'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(1);
  });

  test('refused content is reported with the server problems', async () => {
    server(400);
    const saver = new Saver('rec', 0, null);
    saver.save(payload('x'));
    await vi.advanceTimersByTimeAsync(300);
    expect(saver.status).toEqual({ kind: 'rejected', problems: ['bad'] });
  });

  test('offline: keeps the change and retries with backoff until it is saved', async () => {
    const calls = server('offline', 'offline', 200);
    const saver = new Saver('rec', 0, null);
    saver.save(payload('x'));
    await vi.advanceTimersByTimeAsync(300);
    expect(saver.status.kind).toBe('offline');
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(3);
    expect(saver.status.kind).toBe('saved');
  });

  test('a flush on leaving the page sends at once, with keepalive', async () => {
    const calls = server();
    const saver = new Saver('rec', 0, null);
    saver.save(payload('last edit'));
    expect(await saver.flush(true)).toBe(true);
    expect(calls).toEqual([{ revision: '"0"', notes: 'last edit', keepalive: true }]);
  });
});
