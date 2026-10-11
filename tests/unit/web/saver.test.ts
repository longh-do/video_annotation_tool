import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SavePayload } from '../../../src/core/api-types.ts';
import type { JournalEntry, UnsavedChanges } from '../../../src/web/journal.ts';
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

/** An in-memory journal with the same settle rule as the IndexedDB one; `log` has every state. */
function journal() {
  let entry: JournalEntry | null = null;
  const log: (JournalEntry | null)[] = [];
  const fake: UnsavedChanges & { readonly entry: JournalEntry | null; readonly log: typeof log } = {
    get entry() {
      return entry;
    },
    log,
    write: async (written) => {
      entry = written;
      log.push(entry);
    },
    settle: async (_id, writtenAt, revision) => {
      if (entry && entry.writtenAt <= writtenAt) entry = null;
      else if (entry) entry = { ...entry, baseRevision: revision };
      log.push(entry);
    },
  };
  return fake;
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

  test('every change is journaled at once and forgotten once the server has it', async () => {
    server();
    const unsaved = journal();
    const saver = new Saver('rec', 4, null, unsaved);
    saver.save(payload('edit'));
    expect(unsaved.entry).toMatchObject({ recordingId: 'rec', baseRevision: 4 });
    expect(unsaved.entry?.payload.annotation.notes).toBe('edit');
    await vi.advanceTimersByTimeAsync(300);
    expect(unsaved.entry).toBeNull();
  });

  test('a change made while a save is in flight stays journaled, on top of the new revision', async () => {
    const calls = server();
    const unsaved = journal();
    const saver = new Saver('rec', 0, null, unsaved);
    saver.save(payload('first'));
    const sending = saver.flush();
    saver.save(payload('second'));
    await sending;
    expect(calls.map((c) => [c.revision, c.notes])).toEqual([
      ['"0"', 'first'],
      ['"1"', 'second'],
    ]);
    const notes = (entry: JournalEntry | null) =>
      entry && [entry.baseRevision, entry.payload.annotation.notes];
    expect(unsaved.log.map(notes)).toEqual([[0, 'first'], [0, 'second'], [1, 'second'], null]);
  });

  test('offline, the journal keeps the change until a retry gets through', async () => {
    server('offline', 200);
    const unsaved = journal();
    const saver = new Saver('rec', 0, null, unsaved);
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
});
