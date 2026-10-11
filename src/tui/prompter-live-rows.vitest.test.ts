/** Rows of the running turn that are not a tool call: a note, a decision. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

describe('a note written while the turn runs', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  function window(): { rl: TerminalHarnessPrompter; screen: () => string } {
    const written: string[] = [];
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 30 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter();
    rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
    rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
    return { rl, screen: () => strip(written.join('')) };
  }

  it('is drawn at its place in the live turn, not lost for want of an event', () => {
    const { rl, screen } = window();
    try {
      rl.response('First paragraph of the answer.\n\n');
      rl.activity('Switched to the backup account');
      rl.response('Second paragraph of the answer.\n\n');
      vi.advanceTimersByTime(300);
      const text = screen();
      expect(text).toContain('Switched to the backup account');
      expect(text.lastIndexOf('First paragraph')).toBeLessThan(text.lastIndexOf('Switched to the backup account'));
    } finally { rl.close(); }
  });
});
