import { describe, expect, it } from 'vitest';
// @ts-expect-error The install script's helpers are plain JavaScript.
import { chunksToCarry, elapsedMs, liveStarts } from '../../scripts/release-chunks.mjs';

const HOUR = 60 * 60_000;
const now = 100 * 24 * HOUR;

describe('chunks of an earlier build kept beside a new install', () => {
  it('keeps a chunk that left while a process that started before it left still runs, however long ago', () => {
    const carry = chunksToCarry({
      previous: ['chunk-A.js', 'chunk-B.js', 'chunk-C.js'],
      next: new Set(['chunk-A.js']),
      // B left three days ago; C leaves now.
      left: { 'chunk-B.js': now - 72 * HOUR },
      // A window open for four days.
      starts: [now - 96 * HOUR],
      now,
    });
    expect(carry).toEqual({ 'chunk-B.js': now - 72 * HOUR, 'chunk-C.js': now });
  });

  it('drops a chunk once every process that could ask for it has gone', () => {
    const carry = chunksToCarry({
      previous: ['chunk-B.js', 'chunk-C.js'], next: new Set(), left: { 'chunk-B.js': now - 72 * HOUR },
      // Only processes started after B left: they run builds without it.
      starts: [now - 2 * HOUR], now,
    });
    expect(carry).toEqual({ 'chunk-C.js': now });
    expect(chunksToCarry({ previous: ['chunk-C.js'], next: new Set(), starts: [], now })).toEqual({});
  });

  it('drops nothing when the running processes cannot be listed', () => {
    expect(chunksToCarry({ previous: ['chunk-B.js'], next: new Set(), left: { 'chunk-B.js': 0 }, starts: undefined, now })).toEqual({ 'chunk-B.js': 0 });
  });

  it('reads when each ClikCode process started from ps, and no other process', () => {
    expect(elapsedMs('05')).toBe(5_000);
    expect(elapsedMs('13:29:47')).toBe(13 * HOUR + 29 * 60_000 + 47_000);
    expect(elapsedMs('1-13:44:54')).toBe(37 * HOUR + 44 * 60_000 + 54_000);
    const listing = [
      ' 1-00:00:00 /usr/bin/node /home/u/.local/bin/clikcode sessions resume x',
      '      10:00 node /home/u/.local/share/clikcode/release/dist/index.js session-worker y',
      '   02:00:00 /usr/bin/node /home/u/.local/share/clikcode/node/lib/claude/cli.js',
    ].join('\n');
    expect(liveStarts(['/home/u/.local/bin/clikcode', '/home/u/.local/share/clikcode/release'], now, () => listing))
      .toEqual([now - 24 * HOUR, now - 10 * 60_000]);
    expect(liveStarts(['x'], now, () => { throw new Error('no ps'); })).toBeUndefined();
  });
});
