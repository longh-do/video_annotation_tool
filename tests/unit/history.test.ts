import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  beginGesture,
  cancelGesture,
  canRedo,
  canUndo,
  closeRun,
  commit,
  createHistory,
  endGesture,
  type History,
  RUN_WINDOW_MS,
  redo,
  undo,
} from '../../src/core/history.ts';

describe('history', () => {
  test('undo and redo walk back and forth through commits', () => {
    let h = createHistory('a');
    h = commit(h, 'b');
    h = commit(h, 'c');
    h = undo(h);
    expect(h.present).toBe('b');
    h = undo(h);
    expect(h.present).toBe('a');
    expect(canUndo(h)).toBe(false);
    h = redo(redo(h));
    expect(h.present).toBe('c');
    expect(canRedo(h)).toBe(false);
  });

  test('a commit after undo drops the redo branch', () => {
    const h = commit(undo(commit(createHistory('a'), 'b')), 'c');
    expect(h.present).toBe('c');
    expect(canRedo(h)).toBe(false);
    expect(undo(h).present).toBe('a');
  });

  test('committing the unchanged state records nothing', () => {
    const h = createHistory('a');
    expect(commit(h, 'a')).toBe(h);
  });

  test('a held nudge key is one undo step', () => {
    let h = createHistory(0);
    for (let i = 1; i <= 10; i++) h = commit(h, i, { key: 'nudge:3', now: i * 30 });
    expect(h.past).toEqual([0]);
    h = commit(h, 11, { key: 'nudge:3', now: 300 + RUN_WINDOW_MS + 1 });
    expect(h.past).toEqual([0, 10]);
    h = commit(closeRun(h), 12, { key: 'nudge:3', now: 300 + RUN_WINDOW_MS + 2 });
    expect(h.past).toEqual([0, 10, 11]);
  });

  test('the run window is inclusive at exactly RUN_WINDOW_MS', () => {
    let h = commit(createHistory(0), 1, { key: 'k', now: 0 });
    h = commit(h, 2, { key: 'k', now: RUN_WINDOW_MS });
    expect(h.past).toEqual([0]);
    h = commit(h, 3, { key: 'k', now: 2 * RUN_WINDOW_MS + 1 });
    expect(h.past).toEqual([0, 2]);
  });

  test('a drag is one undo step, and a drag that ends where it began is none', () => {
    let h = beginGesture(createHistory(0));
    for (let i = 1; i <= 5; i++) h = commit(h, i);
    h = endGesture(h);
    expect(h.past).toEqual([0]);
    expect(endGesture(commit(commit(beginGesture(h), 9), 5)).past).toEqual([0]);
  });

  test('undo during a drag cancels it', () => {
    const h = commit(beginGesture(commit(createHistory(0), 1)), 2);
    expect(undo(h).present).toBe(1);
    expect(cancelGesture(h).present).toBe(1);
    expect(canRedo(h)).toBe(false);
  });
});

// Model-based test: the history must behave like a plain list of states plus a cursor.
type Action =
  | { kind: 'commit'; value: number; key: string | null; dt: number }
  | { kind: 'undo' | 'redo' | 'begin' | 'end' | 'cancel' | 'closeRun' };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('commit' as const),
      value: fc.integer({ min: 0, max: 5 }),
      key: fc.constantFrom(null, 'a', 'b'),
      dt: fc.constantFrom(30, 30, 1000),
    }),
  },
  ...(['undo', 'redo', 'begin', 'end', 'cancel', 'closeRun'] as const).map((kind) => ({
    weight: 1,
    arbitrary: fc.constant({ kind }),
  })),
);

interface Model {
  states: number[];
  cursor: number;
  run: { key: string; at: number } | null;
  gesture: { base: number; current: number } | null;
}

function step(h: History<number>, m: Model, a: Action, now: number): History<number> {
  const present = m.gesture?.current ?? m.states[m.cursor]!;
  const push = (value: number) => {
    m.states = [...m.states.slice(0, m.cursor + 1), value];
    m.cursor++;
  };
  switch (a.kind) {
    case 'commit': {
      if (a.value === present) return commit(h, a.value, a.key ? { key: a.key, now } : undefined);
      if (m.gesture) m.gesture.current = a.value;
      else {
        const merges = a.key !== null && m.run?.key === a.key && now - m.run.at <= RUN_WINDOW_MS;
        if (merges) m.states = [...m.states.slice(0, m.cursor), a.value];
        else push(a.value);
        m.run = a.key ? { key: a.key, at: now } : null;
      }
      return commit(h, a.value, a.key ? { key: a.key, now } : undefined);
    }
    case 'undo':
      if (m.gesture) m.gesture = null;
      else if (m.cursor > 0) {
        m.cursor--;
        m.run = null;
      }
      return undo(h);
    case 'redo':
      if (!m.gesture && m.cursor < m.states.length - 1) {
        m.cursor++;
        m.run = null;
      }
      return redo(h);
    case 'begin':
      if (!m.gesture) {
        m.gesture = { base: present, current: present };
        m.run = null;
      }
      return beginGesture(h);
    case 'end':
      if (m.gesture) {
        const { base, current } = m.gesture;
        m.gesture = null;
        if (current !== base) push(current);
      }
      return endGesture(h);
    case 'cancel':
      m.gesture = null;
      return cancelGesture(h);
    case 'closeRun':
      m.run = null;
      return closeRun(h);
  }
}

test('history behaves like a list of states with a cursor', () => {
  fc.assert(
    fc.property(fc.array(actionArb, { maxLength: 200, size: 'max' }), (actions) => {
      let h = createHistory(0);
      const m: Model = { states: [0], cursor: 0, run: null, gesture: null };
      let now = 0;
      for (const action of actions) {
        now += action.kind === 'commit' ? action.dt : 0;
        h = step(h, m, action, now);
        expect(h.present).toBe(m.gesture?.current ?? m.states[m.cursor]);
        expect(canUndo(h)).toBe(m.gesture !== null || m.cursor > 0);
        expect(canRedo(h)).toBe(m.gesture === null && m.cursor < m.states.length - 1);
      }
      // Undoing everything and redoing it all returns to the same state.
      h = endGesture(h);
      const final = h.present;
      let undone = 0;
      while (canUndo(h)) {
        h = undo(h);
        undone++;
      }
      expect(h.present).toBe(0);
      for (let i = 0; i < undone; i++) h = redo(h);
      expect(h.present).toBe(final);
    }),
  );
});
