import { forceCloseDatabase, IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SavePayload } from '../../../src/core/api-types.ts';
import { Journal, type JournalEntry } from '../../../src/web/journal.ts';
import { memoryJournal } from './memory-journal.ts';

const payload = (notes: string) => ({ annotation: { notes } }) as unknown as SavePayload;

function entry(writtenAt: number, notes: string, inFlight: string | null = null): JournalEntry {
  return {
    recordingId: 'rec',
    baseRevision: 4,
    payload: payload(notes),
    inFlight: inFlight === null ? null : payload(inFlight),
    writtenAt,
  };
}

/** The real journal, on an in-memory IndexedDB. */
describe('journal', () => {
  /** The connection the journal opened, to close it as clearing the site's data does. */
  let connection: IDBDatabase | undefined;

  beforeEach(() => {
    const factory = new IDBFactory();
    connection = undefined;
    vi.stubGlobal('indexedDB', {
      open: (name: string, version: number) => {
        const request = factory.open(name, version);
        request.addEventListener('success', () => {
          connection = request.result;
        });
        return request;
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  test('once its database is closed (site data cleared), calls fail as promises, never throw', async () => {
    const journal = (await Journal.open())!;
    forceCloseDatabase(connection as never);
    await expect(journal.write(entry(1, 'x'))).rejects.toThrow();
    await expect(journal.settle('rec', 1, 5)).rejects.toThrow();
    await expect(journal.forget('rec', 1)).rejects.toThrow();
    await expect(journal.read('rec')).rejects.toThrow();
  });

  test('without IndexedDB there is no journal', async () => {
    vi.stubGlobal('indexedDB', undefined);
    expect(await Journal.open()).toBeNull();
  });
});

/** The journal's rules, for the IndexedDB journal and for the saver tests' in-memory one. */
const journals: [
  string,
  () => Promise<{
    write: Journal['write'];
    read: Journal['read'];
    settle: Journal['settle'];
    forget: Journal['forget'];
  }>,
][] = [
  ['the IndexedDB journal', async () => (await Journal.open())!],
  ["the saver tests' journal", async () => memoryJournal()],
];

describe.each(journals)('%s', (_name, open) => {
  beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
  afterEach(() => vi.unstubAllGlobals());

  test('keeps the newest change of each recording', async () => {
    const journal = await open();
    await journal.write(entry(1, 'first'));
    await journal.write(entry(2, 'second'));
    expect(await journal.read('rec')).toEqual(entry(2, 'second'));
    expect(await journal.read('other')).toBeNull();
  });

  test('settling the saved change forgets it; a newer one now builds on the new revision', async () => {
    const journal = await open();
    await journal.write(entry(1, 'first'));
    await journal.settle('rec', 1, 5);
    expect(await journal.read('rec')).toBeNull();

    // Written while 'first' was on its way; then 'first' is saved as revision 5.
    await journal.write(entry(2, 'second', 'first'));
    await journal.settle('rec', 1, 5);
    expect(await journal.read('rec')).toEqual({ ...entry(2, 'second'), baseRevision: 5 });
    await journal.settle('other', 1, 5);
    expect(await journal.read('rec')).not.toBeNull();
  });

  test('forgetting drops the change it names, never a newer one', async () => {
    const journal = await open();
    await journal.write(entry(3, 'newer'));
    await journal.forget('rec', 2);
    expect(await journal.read('rec')).toEqual(entry(3, 'newer'));
    await journal.forget('rec', 3);
    expect(await journal.read('rec')).toBeNull();
  });
});
