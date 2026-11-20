/** The command menu opened while a turn runs is a real menu: Up and Down choose its row, Enter runs that row. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
beforeEach(() => {
  Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
  process.stdout.write = ((_chunk: unknown, ...rest: unknown[]) => {
    for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
    return true;
  }) as typeof process.stdout.write;
});
afterEach(() => { Object.assign(process.stdout, { isTTY: realTty }); process.stdout.write = realWrite; });

describe('the command menu during a turn', () => {
  it('Up and Down choose a row and Enter runs the chosen one, not the first', async () => {
    const rl = new TerminalHarnessPrompter();
    (rl as unknown as { currentSession: unknown }).currentSession = { id: 's', workspace: '/w', messages: [], route: 'gateway' };
    rl.paletteCommands = [
      { label: '/model', value: '/model', detail: 'choose a model' },
      { label: '/effort', value: '/effort', detail: 'choose effort' },
    ] as never;
    const command = vi.fn(async () => ({ disposition: 'command', commandOutcome: 'applied' }) as never);
    rl.startWaiting('thinking', vi.fn(), async () => ({ disposition: 'queued' }) as never, command, vi.fn());
    const key = (k: string): void => (rl as unknown as { onWaitingKey(k: string): void }).onWaitingKey(k);
    try {
      key('\u001b[C');
      expect(rl.composer.text).toBe('/');
      key('\u001b[B');
      // A lone arrow is held a moment to tell a key from a swipe (swipe-arrows.ts), then delivered as a key.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(rl.waitingPaletteSelected).toBe(1);
      // The arrow chose a row; it did not move the draft's cursor or scroll away.
      expect(rl.composer.text).toBe('/');
      key('\r');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(command).toHaveBeenCalledWith('/effort');
      expect(rl.waitingPaletteSelected).toBe(0);
    } finally { rl.close(); }
  });
});
