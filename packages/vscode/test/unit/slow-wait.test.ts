import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { slowWaitGate } from '../../../../src/harness/protocol/slow-wait-gate';
import { SLOW_WAIT_MS } from '../../../../src/harness/protocol/timings';

describe('a loading line in the panel', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('shows only once the wait is slow, ends with the work', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const fast = slowWaitGate(() => seen.push('show fast'), () => seen.push('hide fast'));
    await vi.advanceTimersByTimeAsync(SLOW_WAIT_MS - 1);
    await fast.end();
    const slow = slowWaitGate(() => seen.push('show'), () => seen.push('hide'));
    await vi.advanceTimersByTimeAsync(SLOW_WAIT_MS);
    await slow.end();
    expect(seen).toEqual(['show', 'hide']);
  });

  it('is the page\'s spinner behind that rule in every menu, never a codicon shown at once', () => {
    // The composer's busy line too: VS Code's spinning codicon kept its own pace.
    for (const file of ['picker.tsx', 'screens.tsx', 'composer.tsx', 'main.tsx']) {
      const source = readFileSync(join(__dirname, '../../src/webview', file), 'utf8');
      expect(source, file).not.toMatch(/<Icon name="loading" spin/);
    }
  });
});
