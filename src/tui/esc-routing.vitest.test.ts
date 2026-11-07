/** Esc goes to the topmost open overlay and stops there; only with nothing open does it interrupt the turn. */
import { stdin } from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEP_STDIN_FLOWING, takeTerminalKeys } from './input-decoder.js';
import { TerminalHarnessPrompter } from './prompter.js';

const realTty = process.stdout.isTTY;
const realStdinTty = stdin.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
const ESC = '\u001b';
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function turn(): { rl: TerminalHarnessPrompter; cancel: ReturnType<typeof vi.fn> } {
  const rl = new TerminalHarnessPrompter();
  rl.paletteCommands = [{ value: '/model', description: 'Pick the model' }] as never;
  const cancel = vi.fn();
  rl.startWaiting('thinking', cancel, async () => ({ kind: 'sent' }) as never, async () => ({ kind: 'sent' }) as never);
  return { rl, cancel };
}

describe('Esc routing mid-turn', () => {
  beforeEach(() => {
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
    process.stdout.write = (() => true) as typeof process.stdout.write;
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
    stdin.on('data', KEEP_STDIN_FLOWING);
  });
  afterEach(() => {
    stdin.off('data', KEEP_STDIN_FLOWING);
    stdin.pause();
    Object.assign(stdin, { isTTY: realStdinTty });
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  it('closes the open slash menu and does not interrupt; the next Esc interrupts', async () => {
    const { rl, cancel } = turn();
    try {
      stdin.emit('data', Buffer.from('/'));
      await wait(10);
      stdin.emit('data', Buffer.from(ESC));
      await wait(200);
      expect(cancel).not.toHaveBeenCalled();
      expect(rl.turn?.draft).toBe('');
      stdin.emit('data', Buffer.from(ESC));
      await wait(200);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally { rl.stopWaiting(false); rl.close(); }
  });

  it('gives Esc to an overlay opened over the turn alone, then to the turn once it is closed', async () => {
    const { rl, cancel } = turn();
    try {
      const seen: string[] = [];
      const close = takeTerminalKeys((key) => seen.push(key));
      stdin.emit('data', Buffer.from(ESC));
      await wait(200);
      expect(seen).toEqual([ESC]);
      expect(cancel).not.toHaveBeenCalled();
      close();
      stdin.emit('data', Buffer.from(ESC));
      await wait(200);
      expect(seen).toEqual([ESC]);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally { rl.stopWaiting(false); rl.close(); }
  });

  it('leaves arrow-key sequences whole for the overlay on top', async () => {
    const { rl, cancel } = turn();
    try {
      const seen: string[] = [];
      const close = takeTerminalKeys((key) => seen.push(key));
      stdin.emit('data', Buffer.from('\u001b[A'));
      stdin.emit('data', Buffer.from('\u001b'));
      stdin.emit('data', Buffer.from('[B'));
      await wait(200);
      close();
      expect(seen).toEqual(['\u001b[A', '\u001b[B']);
      expect(cancel).not.toHaveBeenCalled();
    } finally { rl.stopWaiting(false); rl.close(); }
  });
});
