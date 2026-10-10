import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { slowWaitGate } from '../../../../src/harness/protocol/slow-wait-gate';
import { MIN_VISIBLE_MS, SLOW_WAIT_MS } from '../../../../src/harness/protocol/timings';

describe('a loading line in the panel', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('shows only once the wait is slow, then long enough to read, as the terminal\'s do', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const fast = slowWaitGate(() => seen.push('show fast'), () => seen.push('hide fast'));
    await vi.advanceTimersByTimeAsync(SLOW_WAIT_MS - 1);
    await fast.end();
    const slow = slowWaitGate(() => seen.push('show'), () => seen.push('hide'));
    await vi.advanceTimersByTimeAsync(SLOW_WAIT_MS);
    const ended = slow.end();
    await vi.advanceTimersByTimeAsync(MIN_VISIBLE_MS - 1);
    expect(seen).toEqual(['show']);
    await vi.advanceTimersByTimeAsync(1);
    await ended;
    expect(seen).toEqual(['show', 'hide']);
  });

  it('is the page\'s spinner behind that rule in every menu, never a codicon shown at once', () => {
    for (const file of ['picker.tsx', 'screens.tsx']) {
      const source = readFileSync(join(__dirname, '../../src/webview', file), 'utf8');
      expect(source, file).not.toMatch(/<Icon name="loading" spin/);
    }
  });
});
