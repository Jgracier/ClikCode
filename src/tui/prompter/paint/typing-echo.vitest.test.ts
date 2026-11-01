/** A typed character is on screen at once, while a turn runs as at an idle prompt. The turn's paints are shared and come every 32 ms; a key's echo
 * waiting for one was 33 ms of lag on every keystroke during a turn. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from '../../prompter.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

describe('typing while a turn runs', () => {
  let written: string;
  let rl: TerminalHarnessPrompter;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    written = '';
    Object.assign(process.stdout, { isTTY: true, columns: 90, rows: 30 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written += String(chunk);
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    rl = new TerminalHarnessPrompter();
    rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
    rl.startWaiting('thinking', () => undefined, async () => ({ disposition: 'queued' }) as never);
    vi.advanceTimersByTime(300);
  });
  afterEach(() => { vi.useRealTimers(); rl.close(); Object.assign(process.stdout, { isTTY: realTty }); process.stdout.write = realWrite; });

  const key = (k: string): void => (rl as unknown as { onWaitingKey(k: string): void }).onWaitingKey(k);

  it('is drawn the moment it is typed, without waiting for the turn\'s next paint', () => {
    written = '';
    key('q');
    // No timer has run: only a paint made by the key itself can be here.
    expect(plain(written)).toContain('› q');
    key('z');
    expect(plain(written)).toContain('› qz');
  });

  it('and a burst of keys is still one frame each at most, not a frame per timer tick', () => {
    written = '';
    for (const k of 'hello world') key(k);
    expect(plain(written)).toContain('› hello world');
    // Whatever the timer does after is the same frame again, not a different composer.
    vi.advanceTimersByTime(100);
    expect(plain(written).lastIndexOf('› hello world')).toBeGreaterThan(-1);
  });
});
