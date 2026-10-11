import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SavePayload } from '../../../src/core/api-types.ts';
import type { JournalEntry } from '../../../src/web/journal.ts';
import { Saver } from '../../../src/web/saver.ts';
import { memoryJournal } from './memory-journal.ts';

const payload = (notes: string) =>
  ({
    annotation: { status: 'not_reviewed', notes, keep_intervals: [] },
    sidecar: { boundaries: [], review_reason: null },
  }) as unknown as SavePayload;

interface Call {
  readonly revision: string;
  readonly notes: string;
  readonly keepalive: boolean;
}

/**
 * How the fake server answers a save: a status, 'offline' (it never gets the request), 'lost' (it
 * saves, but the answer never comes back), or a status that comes once the promise resolves.
 */
type Reply = number | 'offline' | 'lost' | Promise<number>;

/**
 * A fake server: records each PUT, keeps what was saved, and answers with the next scripted reply
 * (200 once the script runs out). A GET answers with what it holds.
 */
function server(...replies: Reply[]) {
  const calls: Call[] = [];
  let revision = 0;
  let held: SavePayload | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit = {}) => {
      if (init.method !== 'PUT') {
        if (!held) return Response.json({ revision }, { status: 404 });
        return Response.json({ revision, ...held, sidecar: { ...held.sidecar, revision } });
      }
      const body = JSON.parse(String(init.body)) as SavePayload;
      const headers = init.headers as Record<string, string>;
      calls.push({
        revision: headers['If-Match'] ?? '',
        notes: body.annotation.notes,
        keepalive: init.keepalive === true,
      });
      const reply = await (replies.shift() ?? 200);
      if (reply === 'offline') throw new TypeError('Failed to fetch');
      if (reply === 200 || reply === 'lost') {
        revision++;
        held = body;
      }
      if (reply === 'lost') throw new TypeError('Failed to fetch');
      const json = reply === 200 ? { revision, savedAt: 'now' } : { problems: ['bad'], revision };
      return new Response(JSON.stringify(json), { status: reply });
    }),
  );
  return calls;
}

const journal = memoryJournal;

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

  test('every change is journaled at once and forgotten once the server has it', async () => {
    server();
    const unsaved = journal();
    const saver = new Saver('rec', 4, unsaved);
    saver.save(payload('edit'));
    expect(unsaved.entry).toMatchObject({ recordingId: 'rec', baseRevision: 4 });
    expect(unsaved.entry?.payload.annotation.notes).toBe('edit');
    await vi.advanceTimersByTimeAsync(300);
    expect(unsaved.entry).toBeNull();
  });

  test('a change made while a save is in flight stays journaled, on top of the new revision', async () => {
    const calls = server();
    const unsaved = journal();
    const saver = new Saver('rec', 0, unsaved);
    saver.save(payload('first'));
    const sending = saver.flush();
    saver.save(payload('second'));
    await sending;
    expect(calls.map((c) => [c.revision, c.notes])).toEqual([
      ['"0"', 'first'],
      ['"1"', 'second'],
    ]);
    const notes = (entry: JournalEntry | null) =>
      entry && [
        entry.baseRevision,
        entry.payload.annotation.notes,
        entry.inFlight?.annotation.notes,
      ];
    // The second change was written while the first was on its way: the journal says so.
    expect(unsaved.log.map(notes)).toEqual([
      [0, 'first', undefined],
      [0, 'second', 'first'],
      [1, 'second', undefined],
      null,
    ]);
  });

  test('offline, the journal keeps the change until a retry gets through', async () => {
    server('offline', 200);
    const unsaved = journal();
    const saver = new Saver('rec', 0, unsaved);
    saver.save(payload('x'));
    await vi.advanceTimersByTimeAsync(300);
    expect(unsaved.entry?.payload.annotation.notes).toBe('x');
    await vi.advanceTimersByTimeAsync(1000);
    expect(saver.status.kind).toBe('saved');
    expect(unsaved.entry).toBeNull();
  });

  test('says "saving" from the moment a change waits, not only once it is sent', () => {
    server();
    const saver = new Saver('rec', 0, null);
    expect(saver.status.kind).toBe('saved');
    saver.save(payload('x'));
    expect(saver.status.kind).toBe('saving');
  });

  test('changes that keep coming are still sent within two seconds', async () => {
    const calls = server();
    const saver = new Saver('rec', 0, null);
    for (let i = 0; i < 12; i++) {
      saver.save(payload(`edit ${i}`));
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(calls.map((c) => c.notes)).toEqual(['edit 9']);
  });

  test('content the server refuses is dropped from the journal: it would only be refused again', async () => {
    server(400);
    const unsaved = journal();
    const saver = new Saver('rec', 0, unsaved);
    saver.save(payload('bad'));
    await vi.advanceTimersByTimeAsync(300);
    expect(saver.status.kind).toBe('rejected');
    expect(unsaved.entry).toBeNull();
  });

  test('a save whose answer was lost is no conflict: the server already holds it', async () => {
    const calls = server('lost', 412);
    const unsaved = journal();
    const saver = new Saver('rec', 0, unsaved);
    saver.save(payload('x'));
    await vi.advanceTimersByTimeAsync(300);
    expect(saver.status.kind).toBe('offline');
    await vi.advanceTimersByTimeAsync(1000); // sent again: 412, and the server holds exactly 'x'
    expect(saver.status.kind).toBe('saved');
    expect(saver.revision).toBe(1);
    expect(unsaved.entry).toBeNull();
    saver.save(payload('y'));
    await vi.advanceTimersByTimeAsync(300);
    expect(calls.map((c) => [c.revision, c.notes])).toEqual([
      ['"0"', 'x'],
      ['"0"', 'x'],
      ['"1"', 'y'],
    ]);
    expect(saver.status.kind).toBe('saved');
  });

  test('offline, changes are journaled with the save whose answer never came', async () => {
    server('offline');
    const unsaved = journal();
    const saver = new Saver('rec', 0, unsaved);
    saver.save(payload('x'));
    await vi.advanceTimersByTimeAsync(300); // sent; maybe saved, maybe not
    saver.save(payload('y'));
    // If 'x' landed, 'y' still reopens on top of it after a reload.
    expect(unsaved.entry).toMatchObject({ baseRevision: 0, inFlight: payload('x') });
    expect(unsaved.entry?.payload.annotation.notes).toBe('y');
  });

  test('a journal whose database was closed never makes a save look failed', async () => {
    const calls = server();
    const closed = () => {
      throw new DOMException('The database connection is closing.', 'InvalidStateError');
    };
    // Settling throws once the save is done, e.g. after "Clear site data".
    const saver = new Saver('rec', 0, { write: async () => {}, settle: closed, forget: closed });
    saver.save(payload('x'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(1);
    expect(saver.status.kind).toBe('saved');
    // Writing throws too.
    const other = new Saver('rec', 1, { write: closed, settle: closed, forget: closed });
    other.save(payload('y'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(2);
    expect(other.status.kind).toBe('saved');
  });

  test('a flush on leaving while a save is on its way sends what follows with keepalive', async () => {
    let answer = (_status: number) => {};
    const calls = server(new Promise((resolve) => (answer = resolve)));
    const saver = new Saver('rec', 0, null);
    saver.save(payload('first'));
    await vi.advanceTimersByTimeAsync(300); // on its way, no answer yet
    saver.save(payload('second'));
    const leaving = saver.flush(true);
    answer(200);
    expect(await leaving).toBe(true);
    expect(calls.map((c) => [c.notes, c.keepalive])).toEqual([
      ['first', false],
      ['second', true],
    ]);
  });

  test('the status tells a server error from no connection, and whether this computer keeps the change', async () => {
    server(500, 'offline', 500);
    const saver = new Saver('rec', 0, journal());
    saver.save(payload('x'));
    await vi.advanceTimersByTimeAsync(300);
    expect(saver.status).toEqual({ kind: 'offline', serverError: 'bad', kept: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(saver.status).toEqual({ kind: 'offline', serverError: null, kept: true });
    // Without a journal (a private window), nothing is kept on this computer.
    const alone = new Saver('rec', 0, null);
    alone.save(payload('y'));
    await vi.advanceTimersByTimeAsync(300);
    expect(alone.status).toEqual({ kind: 'offline', serverError: 'bad', kept: false });
  });
});
