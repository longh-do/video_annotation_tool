import { describe, expect, test } from 'vitest';
import { durationSeconds, isNsString, parseNs } from '../../src/core/ns.ts';

describe('nanosecond timestamps', () => {
  test('parse canonical decimal strings exactly, including epoch-sized values', () => {
    expect(parseNs('0')).toBe(0n);
    expect(parseNs('3016550386977')).toBe(3_016_550_386_977n);
    // A double would round this to ...849300.
    expect(parseNs('1760000405418849217')).toBe(1_760_000_405_418_849_217n);
    expect(String(parseNs('1760000405418849217'))).toBe('1760000405418849217');
  });

  test.each(['', '-1', '+1', '1.5', '1e9', ' 1', '01', '0x10', '9223372036854775808'])(
    'reject %j',
    (text) => {
      expect(isNsString(text)).toBe(false);
      expect(() => parseNs(text)).toThrow(RangeError);
    },
  );

  test('accept the largest 64-bit value', () => {
    expect(isNsString('9223372036854775807')).toBe(true);
  });

  test('turn durations into seconds', () => {
    expect(durationSeconds(1_760_000_001_500_000_000n - 1_760_000_000_000_000_000n)).toBe(1.5);
    expect(durationSeconds(-10n)).toBe(-1e-8);
  });
});
