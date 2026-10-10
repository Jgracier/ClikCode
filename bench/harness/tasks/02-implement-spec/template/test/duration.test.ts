import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, parseDuration } from '../src/duration.ts';

test('parses a single part', () => {
  assert.equal(parseDuration('90s'), 90_000);
});

test('formats hours and minutes', () => {
  assert.equal(formatDuration(5_400_000), '1h30m');
});
