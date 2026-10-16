/** Esc and Ctrl+C stop the running chat instead of leaving for Chats. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
function silentTty(): void {
  Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
  process.stdout.write = (() => true) as typeof process.stdout.write;
}

function follow(): { rl: TerminalHarnessPrompter; key: (k: string) => void; cancel: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn> } {
  const rl = new TerminalHarnessPrompter();
  const cancel = vi.fn();
  const leave = vi.fn();
  rl.startWaiting('thinking', cancel, async () => ({ kind: 'sent' }) as never, undefined, leave);
  const key = (k: string): void => (rl as unknown as { onWaitingKey(k: string): void }).onWaitingKey(k);
  return { rl, key, cancel, leave };
}

describe('Esc and Ctrl+C on the waiting display', () => {
  beforeEach(silentTty);
  afterEach(() => { Object.assign(process.stdout, { isTTY: realTty }); process.stdout.write = realWrite; });

  it('Esc stops the chat instead of opening Chats', () => {
    const { rl, key, cancel, leave } = follow();
    try {
      key('\u001b');
      expect(cancel).toHaveBeenCalledWith(true, 'esc');
      expect(leave).not.toHaveBeenCalled();
    } finally { rl.close(); }
  });

  it('Ctrl+C also stops the chat', () => {
    const { rl, key, cancel, leave } = follow();
    try {
      key('\u0003');
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(leave).not.toHaveBeenCalled();
    } finally { rl.close(); }
  });

});
