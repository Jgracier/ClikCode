/** One composer, at rest and while a turn runs: a frame redraws what is typed, never a copy of an old frame, and the same keys
 * mean the same things in both. */
import { stdin } from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEP_STDIN_FLOWING } from '../input-decoder.js';
import { TerminalHarnessPrompter } from '../prompter.js';
import { SWIPE_BURST_MS } from '../swipe-arrows.js';
import { EXIT_CONFIRM_MS } from './state.js';

const realTty = process.stdout.isTTY;
const realInTty = stdin.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
const session = { id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never;
const PASTE = (text: string): string => `\u001b[200~${text}\u001b[201~`;

function open() {
  const rl = new TerminalHarnessPrompter();
  rl.render(session);
  const paint = vi.spyOn(rl, 'paint');
  // A person pressing a key: one read, and the next one a while later (a burst of arrows is a swipe: swipe-arrows.ts).
  const press = (text: string): void => { stdin.emit('data', Buffer.from(text)); vi.advanceTimersByTime(SWIPE_BURST_MS + 40); };
  const shown = (): { text: string; options: number; cursor: number } => {
    const call = paint.mock.calls.at(-1)!;
    return { text: call[0] as string, options: (call[1] as unknown[]).length, cursor: call[4] as number };
  };
  return { rl, paint, press, shown };
}

describe('the composer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
    process.stdout.write = ((...args: unknown[]) => { for (const arg of args) if (typeof arg === 'function') (arg as () => void)(); return true; }) as typeof process.stdout.write;
    stdin.on('data', KEEP_STDIN_FLOWING);
  });
  afterEach(() => {
    vi.useRealTimers();
    stdin.off('data', KEEP_STDIN_FLOWING); stdin.pause();
    Object.assign(process.stdout, { isTTY: realTty });
    Object.assign(stdin, { isTTY: realInTty });
    process.stdout.write = realWrite;
  });

  it('keeps a resting draft and its palette on screen when a snapshot or setting renders the chat again', () => {
    const { rl, press, shown } = open();
    try {
      void rl.question('› ', [{ label: '/model', value: '/model' }] as never, { conversation: true }).catch(() => undefined);
      press('hel');
      rl.render(session);
      expect(shown()).toMatchObject({ text: 'hel', cursor: 3 });
      expect(rl.idleForBuildReplace()).toBe(false);
      press('\u0015');
      press('/');
      rl.render(session);
      expect(shown()).toMatchObject({ text: '/', options: 1 });
    } finally { rl.close(); }
  });

  it('draws a secret as dots on the way back from Ctrl+Z, as every other frame does', () => {
    const { rl, shown } = open();
    try {
      rl.startWaiting('signing in', () => undefined);
      rl.signInInput = { secret: true, submit: () => undefined };
      for (const k of 'sk-live-123') rl.onWaitingKey(k);
      expect(shown().text).toBe('•'.repeat(11));
      vi.spyOn(rl, 'retakeScreen').mockImplementation(() => undefined);
      rl.onContinue();
      expect(shown().text).toBe('•'.repeat(11));
    } finally { rl.close(); }
  });

  it('takes a prompt\'s Ctrl+C notice down with the prompt, so its expiry draws nothing of a prompt that is gone', () => {
    const { rl, paint, press } = open();
    try {
      const abort = new AbortController();
      void rl.question('› ', [], { conversation: true, signal: abort.signal }).catch(() => undefined);
      press('\u0003');
      expect(rl.transientNotice).toBeDefined();
      abort.abort();
      expect(rl.transientNotice).toBeUndefined();
      rl.startWaiting('thinking', () => undefined, async () => ({ disposition: 'queued' }) as never);
      rl.onWaitingKey('x');
      paint.mockClear();
      vi.advanceTimersByTime(EXIT_CONFIRM_MS + 10);
      for (const call of paint.mock.calls) expect(call[0]).toBe('x');
    } finally { rl.close(); }
  });

  it('keeps a draft from rest into a turn that starts under it, and on after the turn', () => {
    const { rl, press, shown } = open();
    try {
      const abort = new AbortController();
      void rl.question('› ', [], { conversation: true, signal: abort.signal }).catch(() => undefined);
      press('half a thought');
      // A turn this window did not start takes the screen.
      abort.abort();
      rl.startWaiting('thinking', () => undefined, async () => ({ disposition: 'queued' }) as never);
      expect(shown().text).toBe('half a thought');
      rl.stopWaiting();
      expect(shown().text).toBe('half a thought');
    } finally { rl.close(); }
  });

  it('recalls past prompts with Up (or Ctrl+P) during a turn, as at rest; Down never empties the draft', () => {
    const { rl, shown } = open();
    try {
      rl.history.push('first message', 'second message');
      rl.startWaiting('thinking', () => undefined, async () => ({ disposition: 'queued' }) as never);
      const key = (k: string): void => { rl.onWaitingKey(k); vi.advanceTimersByTime(SWIPE_BURST_MS + 40); };
      key('\u001b[A');
      expect(shown().text).toBe('second message');
      key('\u0010');
      expect(shown().text).toBe('first message');
      key('\u001b[B');
      key('\u001b[B');
      expect(shown().text).toBe('');
      for (const k of 'mine') key(k);
      key('\u001b[B');
      expect(shown().text).toBe('mine');
    } finally { rl.close(); }
  });

  it('holds a long paste as a placeholder during a turn, as at rest, and sends it whole', () => {
    const { rl, shown } = open();
    try {
      const submit = vi.fn(async () => ({ disposition: 'queued' }) as never);
      rl.startWaiting('thinking', () => undefined, submit);
      const log = Array.from({ length: 40 }, (_, n) => `log line ${n}`).join('\n');
      rl.onWaitingKey(PASTE(log));
      expect(shown().text).toBe('[Pasted text #1 +40 lines]');
      rl.onWaitingKey('\r');
      expect(submit).toHaveBeenCalledWith(log, expect.any(String));
    } finally { rl.close(); }
  });
});
