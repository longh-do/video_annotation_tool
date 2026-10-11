/**
 * Source-clock nanosecond timestamps.
 *
 * They are `bigint` in memory and decimal strings on disk, never JS Numbers. Today's values
 * (host uptime, ~3e12) would happen to fit a double, but epoch-based clocks (~1.8e18) would not,
 * and the data contract forbids it. The one Number conversion allowed is for a duration, in
 * `durationSeconds`. A lint rule (lint-rules/no-number-ns.grit) guards the rest.
 */

const DECIMAL = /^(0|[1-9]\d*)$/;
const MAX_INT64 = (1n << 63n) - 1n;

/** True for a canonical non-negative decimal integer string ("0", "3016550386977"). */
export function isNsString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL.test(value) && BigInt(value) <= MAX_INT64;
}

/** Parses a canonical decimal string; throws on signs, decimals, exponents or > 64 bits. */
export function parseNs(text: string): bigint {
  if (!isNsString(text)) throw new RangeError(`not a nanosecond timestamp: "${text}"`);
  return BigInt(text);
}

/** A duration (the difference of two timestamps) in seconds, for display and metrics. */
export function durationSeconds(ns: bigint): number {
  // biome-ignore lint/plugin/no-number-ns: durations under ~104 days are exact in a double
  return Number(ns) / 1e9;
}
