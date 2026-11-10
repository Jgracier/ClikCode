/** Terminal state the program sets and must not leave behind: alternate scroll (?1007) and the kitty keyboard stack. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceCliWithNewBuild } from '../commands/ai/build-replace.js';
import { sessionModesOn, sessionModesOff } from './modes.js';
import { terminalModes, terminalPrepare, terminalTeardown } from './restore.js';

const count = (text: string, part: string): number => text.split(part).length - 1;

describe('modes the program leaves set', () => {
  beforeEach(() => { vi.stubEnv('CLIKCODE_INLINE', ''); vi.stubEnv('CLIKCODE_MOUSE', ''); vi.stubEnv('TMUX', ''); vi.stubEnv('CLIKCODE_NO_KITTY_KEYBOARD', ''); vi.stubEnv('STY', ''); vi.stubEnv('TERM', 'xterm-kitty'); });
  afterEach(() => { vi.unstubAllEnvs(); terminalModes.alternateScroll = false; terminalModes.kittyKeyboard = false; });

  it('alternate scroll is reset on both screens where it was set, once', () => {
    expect(sessionModesOn()).toContain('\u001b[?1007h');
    const out = terminalTeardown(true);
    expect(count(out, '\u001b[?1007l')).toBe(2);
    expect(terminalTeardown(true)).not.toContain('?1007');
  });

  it('handing the terminal to something else (Ctrl+Z, a picker) resets it too, and the next take asks again', () => {
    sessionModesOn();
    expect(sessionModesOff(true)).toContain('\u001b[?1007l');
    expect(sessionModesOn()).toContain('\u001b[?1007h');
  });

  it('a process that never asked for it does not reset it', () => {
    expect(terminalTeardown(true)).not.toContain('?1007');
  });

  it('start-up clears the kitty keyboard stack a predecessor left, but not where the push is not understood', () => {
    expect(terminalPrepare()).toContain('\u001b[<99u');
    vi.stubEnv('CLIKCODE_NO_KITTY_KEYBOARD', '1');
    expect(terminalPrepare()).not.toContain('<99u');
  });
});

describe('a re-exec', () => {
  it('pops this process\'s kitty keyboard entry before the exec', async () => {
    const order: string[] = [];
    const realExecve = (process as { execve?: unknown }).execve;
    (process as { execve?: unknown }).execve = () => { order.push('execve'); };
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (String(chunk)) order.push(JSON.stringify(String(chunk)));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as never);
    // The real exec never returns; the fallback after it would start a child and exit, which a test must not.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    terminalModes.kittyKeyboard = true;
    try {
      await replaceCliWithNewBuild({ sessionId: 's', entry: '/dev/null', release: async () => undefined, closeUi: () => undefined });
      expect(order.indexOf(JSON.stringify('\u001b[<u'))).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(JSON.stringify('\u001b[<u'))).toBeLessThan(order.indexOf('execve'));
      expect(terminalModes.kittyKeyboard).toBe(false);
    } finally {
      write.mockRestore(); exit.mockRestore();
      (process as { execve?: unknown }).execve = realExecve;
      terminalModes.kittyKeyboard = false;
    }
  });
});
