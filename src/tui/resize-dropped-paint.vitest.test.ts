/** A change that arrives while a resize settles is not lost: the paint that came due for it was dropped, and the settle draws it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';
import { TestScreen } from './inline-screen.vitest-helper.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

describe('a status change during a resize settle', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.stubEnv('CLIKCODE_INLINE', ''); vi.stubEnv('STY', ''); vi.stubEnv('TMUX', ''); });
  afterEach(() => {
    vi.useRealTimers(); vi.unstubAllEnvs();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  it('is on the screen once the settle ends', () => {
    const term = new TestScreen(20, 60);
    Object.assign(process.stdout, { isTTY: true, columns: 60, rows: 20 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      term.write(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter();
    try {
      rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
      vi.advanceTimersByTime(300);
      // One size, drawn whole when it arrives; the settle timer then runs 100 ms.
      (rl as unknown as { onResize(): void }).onResize();
      vi.advanceTimersByTime(20);
      rl.setTransfer('s', 'Fetching LATEMODEL 40%');
      vi.advanceTimersByTime(1000);
      expect(term.screen().join('\n')).toContain('LATEMODEL');
    } finally { rl.close(); }
  });
});
