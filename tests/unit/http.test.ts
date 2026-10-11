import { describe, expect, test } from 'vitest';
import { isLocalHost } from '../../src/server/http.ts';

describe('http', () => {
  test('answers only requests addressed to this machine by name', () => {
    expect(isLocalHost('127.0.0.1:5173')).toBe(true);
    expect(isLocalHost('localhost:5173')).toBe(true);
    expect(isLocalHost('localhost')).toBe(true);
    // A site that points its own name at 127.0.0.1 still sends that name.
    expect(isLocalHost('attacker.example:5173')).toBe(false);
    expect(isLocalHost('localhost.attacker.example')).toBe(false);
    expect(isLocalHost('127.0.0.1.attacker.example:5173')).toBe(false);
    expect(isLocalHost(undefined)).toBe(false);
  });
});
