/** Inline, the terminal keeps the conversation in its own scrollback and scrolls it itself: this program never scrolls a view
 * of its own there, and Ctrl+L draws the screen again whole. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';
import { eraseInlineBlock, inlineBlock } from './inline.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
const session = {
  id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active',
  messages: Array.from({ length: 60 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: `message ${n}` })),
} as never;

describe('inline mode', () => {
  let written: string[];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.stubEnv('CLIKCODE_INLINE', '1');
    vi.stubEnv('CLIKDEPLOY_CLIENT', '');
    written = [];
    Object.assign(process.stdout, { isTTY: true, columns: 80, rows: 24 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(() => {
    vi.useRealTimers(); vi.unstubAllEnvs(); eraseInlineBlock(); inlineBlock.clearNext = false;
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  it('never scrolls a view of its own: page keys move nothing, and Esc still reaches the turn', () => {
    const rl = new TerminalHarnessPrompter();
    try {
      rl.render(session);
      vi.advanceTimersByTime(100);
      expect(rl.scrollTranscript(10)).toBe(false);
      rl.handleScrollKey('\u001b[5~');
      rl.handleScrollKey('\u0002');
      expect(rl.scrolledBack).toBe(false);
      const cancel = vi.fn();
      rl.startWaiting('thinking', cancel, async () => ({ disposition: 'queued' }) as never);
      rl.response('an answer');
      rl.onWaitingKey('\u001b[5~');
      rl.onWaitingKey('\u001b');
      expect(cancel).toHaveBeenCalled();
    } finally { rl.close(); }
  });

  it('draws the screen again on Ctrl+L, though nothing in the block changed', () => {
    const rl = new TerminalHarnessPrompter();
    try {
      rl.render(session);
      vi.advanceTimersByTime(100);
      written.length = 0;
      rl.repairScreen();
      vi.advanceTimersByTime(100);
      expect(written.join('')).toContain('message 59');
    } finally { rl.close(); }
  });
});
