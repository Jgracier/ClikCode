/** A sign-in's link belongs to the conversation that asked for it: a window that
 * moves to another conversation does not carry it along. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
const session = (id: string): never => ({ id, route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] }) as never;
const LINK = 'https://claude.example/oauth/authorize?code=true&state=abc';

describe('sign-in scope', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); Object.assign(process.stdout, { isTTY: realTty }); process.stdout.write = realWrite; });

  function window(): TerminalHarnessPrompter {
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 30 });
    process.stdout.write = ((_chunk: string | Uint8Array, ...rest: unknown[]) => {
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter();
    rl.render(session('A'));
    rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
    return rl;
  }

  it('the link is dropped when the window opens another conversation', () => {
    const rl = window();
    try {
      const screen = rl.signInScreen('Claude Code');
      screen.show({ url: LINK } as never);
      expect(rl.signInLines.join('\n')).toContain('oauth/authorize');
      rl.render(session('B'));
      expect(rl.signInLines).toEqual([]);
      expect(rl.signingIn).toBe(false);
      expect(screen.signal.aborted).toBe(true);
    } finally { rl.close(); }
  });

  it('the link is drawn in the band only: never a transcript row, while shown or after', () => {
    const rl = window();
    try {
      const screen = rl.signInScreen('Claude Code');
      screen.show({ url: LINK } as never);
      rl.flushPaint();
      expect(rl.alternateTranscript.join('\n')).not.toContain('oauth/authorize');
      screen.stop();
      rl.render(session('A'));
      expect(rl.alternateTranscript.join('\n')).not.toContain('oauth/authorize');
      expect(rl.signInLines).toEqual([]);
    } finally { rl.close(); }
  });

  it('a sign-in asked in the conversation on screen stays when it is drawn again', () => {
    const rl = window();
    try {
      const screen = rl.signInScreen('Claude Code');
      screen.show({ url: LINK } as never);
      rl.render(session('A'));
      expect(rl.signInLines.join('\n')).toContain('oauth/authorize');
      expect(screen.signal.aborted).toBe(false);
      screen.stop();
      expect(rl.signInOwner).toBeUndefined();
    } finally { rl.close(); }
  });
});
