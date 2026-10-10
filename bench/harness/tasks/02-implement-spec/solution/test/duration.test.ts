import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, parseDuration } from '../src/duration.ts';

test('parses a single part', () => {
  assert.equal(parseDuration('90s'), 90_000);
});

test('parses several parts', () => {
  assert.equal(parseDuration('1m500ms'), 60_500);
});

test('rejects invalid text', () => {
  for (const text of ['', '5y', '1.5h', '30m1h']) assert.throws(() => parseDuration(text), RangeError);
});

test('formats hours and minutes', () => {
  assert.equal(formatDuration(5_400_000), '1h30m');
});
