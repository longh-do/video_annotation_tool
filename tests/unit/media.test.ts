import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseRange, sendFile } from '../../src/server/media.ts';
import { tempDir } from './fixtures.ts';

describe('parseRange', () => {
  test.each([
    ['bytes=0-1', { start: 0, end: 1 }],
    ['bytes=5-', { start: 5, end: 9 }],
    ['bytes=-3', { start: 7, end: 9 }],
    ['bytes=-30', { start: 0, end: 9 }],
    ['bytes=8-100', { start: 8, end: 9 }],
    ['bytes=10-', 'unsatisfiable'],
    ['bytes=-0', 'unsatisfiable'],
    ['bytes=3-1', null], // malformed: send the whole file
    ['bytes=0-1,4-5', null], // several ranges: send the whole file
    ['items=0-1', null],
    ['bytes=-', null],
  ])('%s of a 10-byte file', (header, expected) => {
    expect(parseRange(header, 10)).toEqual(expected);
  });

  test('no header means the whole file', () => {
    expect(parseRange(undefined, 10)).toBeNull();
  });
});

describe('sendFile', () => {
  let dir = '';
  let base = '';
  const server = createServer((req, res) => void sendFile(req, res, join(dir, 'clip.mp4')));

  beforeAll(async () => {
    dir = await tempDir();
    await writeFile(join(dir, 'clip.mp4'), '0123456789');
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  test('answers a range request with 206 and just those bytes', async () => {
    const res = await fetch(base, { headers: { Range: 'bytes=2-5' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(await res.text()).toBe('2345');
  });

  test('sends the whole file without a range, and advertises range support', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe('0123456789');
  });

  test('refuses a range past the end with 416', async () => {
    const res = await fetch(base, { headers: { Range: 'bytes=50-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
  });

  test('answers HEAD with headers only', async () => {
    const res = await fetch(base, { method: 'HEAD', headers: { Range: 'bytes=0-0' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-length')).toBe('1');
    expect(await res.text()).toBe('');
  });
});
