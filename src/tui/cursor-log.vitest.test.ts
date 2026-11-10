/** The cursor log is buffered: no file call per control key, one write a second and at exit. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushCursorLog, logCursorEvent } from './cursor-log.js';
import { stateDirectory } from '../session/store/paths.js';

describe('cursor.log', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { flushCursorLog(); vi.useRealTimers(); });

  it('writes nothing while keys arrive, then every line in one write after a second', () => {
    const file = join(stateDirectory(), 'cursor.log');
    flushCursorLog();
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    for (let n = 0; n < 25; n += 1) logCursorEvent(`input "\\u001b[A" n=${n}`);
    expect(existsSync(file) ? readFileSync(file, 'utf8') : '').toBe(before);
    vi.advanceTimersByTime(1_000);
    const written = readFileSync(file, 'utf8').slice(before.length);
    expect(written.trim().split('\n')).toHaveLength(25);
    expect(written).toContain('n=24');
  });

  it('flushes what is queued when asked (the exit hook)', () => {
    const file = join(stateDirectory(), 'cursor.log');
    logCursorEvent('input "x" marker-at-exit');
    flushCursorLog();
    expect(readFileSync(file, 'utf8')).toContain('marker-at-exit');
  });
});
