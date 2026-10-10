import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, parseDuration } from '../src/duration.ts';
import { UNIT_MS } from '../src/units.ts';

test('hidden: unit table', () => {
  assert.deepEqual({ ...UNIT_MS }, { w: 604800000, d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 });
});

test('hidden: parse valid', () => {
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('2d4h'), 2 * 86_400_000 + 4 * 3_600_000);
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('1m500ms'), 60_500);
  assert.equal(parseDuration('  1w  '), 604_800_000);
  assert.equal(parseDuration('0s'), 0);
});

test('hidden: parse invalid', () => {
  for (const text of ['', '5y', 'h', '1.5h', '-5s', '42', '30m1h', '1h1h', '1h 30m', 'ms5']) {
    assert.throws(() => parseDuration(text), (error: unknown) => error instanceof RangeError && error.message.includes(text), `should reject ${JSON.stringify(text)}`);
  }
});

test('hidden: format', () => {
  assert.equal(formatDuration(0), '0ms');
  assert.equal(formatDuration(1500), '1s500ms');
  assert.equal(formatDuration(604_800_000 + 60_000), '1w1m');
  assert.throws(() => formatDuration(-1), RangeError);
  assert.throws(() => formatDuration(1.5), RangeError);
});

test('hidden: round trip', () => {
  for (const x of [0, 1, 999, 1000, 61_001, 3_600_000, 90_061_001, 1_209_600_123]) {
    assert.equal(parseDuration(formatDuration(x)), x);
  }
});
