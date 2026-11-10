/** suspend() hands the real terminal to a child (a picker, a vendor login, a remote chat): the main screen, as Ctrl+Z gives it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';
import { historyDump } from './restore.js';
import { TestScreen } from './inline-screen.vitest-helper.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

describe('suspend() in full-screen mode', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.stubEnv('CLIKCODE_INLINE', ''); vi.stubEnv('STY', ''); vi.stubEnv('TMUX', ''); });
  afterEach(() => {
    vi.useRealTimers(); vi.unstubAllEnvs();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
    historyDump.source = undefined; historyDump.suppressed = false;
  });

  function open(): { rl: TerminalHarnessPrompter; term: TestScreen; writes: string[] } {
    const term = new TestScreen(12, 60);
    const writes: string[] = [];
    term.write('shell prompt$ \r\n');
    Object.assign(process.stdout, { isTTY: true, columns: 60, rows: 12 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      writes.push(String(chunk)); term.write(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    return { rl: new TerminalHarnessPrompter(), term, writes };
  }

  it('leaves the alternate screen, writes the conversation once, lets a child that uses the alternate screen leave it, and takes it back', async () => {
    const { rl, term } = open();
    try {
      rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [
        { role: 'user', content: 'ROW one' }, { role: 'assistant', content: 'ROW two' }, { role: 'assistant', content: 'ROW three' },
      ] } as never);
      vi.advanceTimersByTime(300);
      expect(term.alt).toBe(true);
      await rl.suspend();
      expect(term.alt).toBe(false);
      expect(term.mainScreen().join('\n')).toContain('ROW three');
      expect(term.mainScreen().join('\n')).not.toContain('> composer');
      // The child draws on the alternate screen itself and leaves it: the main screen it returns to is the one it was given.
      term.write('\u001b[?1049hchild full-screen UI\u001b[?1049l');
      expect(term.alt).toBe(false);
      expect(term.mainScreen().join('\n')).toContain('ROW three');
      rl.resume();
      vi.advanceTimersByTime(300);
      expect(term.alt).toBe(true);
      expect(term.screen().join('\n')).toContain('ROW three');
      // Back in the UI the rows are not written under the shell a second time at exit.
      const before = term.mainScreen().join('\n').split('ROW one').length;
      expect(before).toBe(2);
    } finally { rl.close(); }
  });
});
