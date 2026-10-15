/** What Esc and Ctrl+C do on the waiting display, by what the window follows: a turn ClikCode started is
 * the user's to stop; the vendor's own background work is not ClikCode's to stop on an Esc. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
function silentTty(): void {
  Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
  process.stdout.write = (() => true) as typeof process.stdout.write;
}

function follow(options?: { vendorWork?: boolean }): { rl: TerminalHarnessPrompter; key: (k: string) => void; cancel: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn> } {
  const rl = new TerminalHarnessPrompter();
  const cancel = vi.fn();
  const leave = vi.fn();
  rl.startWaiting('thinking', cancel, async () => ({ kind: 'sent' }) as never, undefined, leave);
  if (options?.vendorWork) rl.markVendorWork();
  const key = (k: string): void => (rl as unknown as { onWaitingKey(k: string): void }).onWaitingKey(k);
  return { rl, key, cancel, leave };
}

describe('Esc and Ctrl+C on the waiting display', () => {
  beforeEach(silentTty);
  afterEach(() => { Object.assign(process.stdout, { isTTY: realTty }); process.stdout.write = realWrite; });

  it('Esc on the vendor\'s own background work leaves the display and sends no Stop', () => {
    const { rl, key, cancel, leave } = follow({ vendorWork: true });
    try {
      key('\u001b');
      expect(leave).toHaveBeenCalledTimes(1);
      expect(cancel).not.toHaveBeenCalled();
    } finally { rl.close(); }
  });

  it('Ctrl+C on it is still the explicit Stop', () => {
    const { rl, key, cancel, leave } = follow({ vendorWork: true });
    try {
      key('\u0003');
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(leave).not.toHaveBeenCalled();
    } finally { rl.close(); }
  });

  it('Esc on a turn ClikCode started still stops it (an unanswered prompt comes back to edit)', () => {
    const { rl, key, cancel, leave } = follow();
    try {
      key('\u001b');
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith(true, 'esc');
      expect(leave).not.toHaveBeenCalled();
    } finally { rl.close(); }
  });
});
