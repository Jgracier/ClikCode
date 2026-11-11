/** Reading the conversation back: the rows being read stay where they are,
 * whatever the band under them does, and a swipe that reaches the first row
 * stays a swipe. */
import { stdin } from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEP_STDIN_FLOWING } from './input-decoder.js';
import { TerminalHarnessPrompter } from './prompter.js';

const realTty = process.stdout.isTTY;
const realInTty = stdin.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
const session = { id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never;

describe('reading back', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 30 });
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
    process.stdout.write = ((_chunk: unknown, ...rest: unknown[]) => {
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    stdin.on('data', KEEP_STDIN_FLOWING);
  });
  afterEach(() => {
    vi.useRealTimers();
    stdin.off('data', KEEP_STDIN_FLOWING); stdin.pause();
    Object.assign(process.stdout, { isTTY: realTty });
    Object.assign(stdin, { isTTY: realInTty });
    process.stdout.write = realWrite;
  });

  function turnScrolledBack(): { rl: TerminalHarnessPrompter; top: () => string } {
    const rl = new TerminalHarnessPrompter();
    rl.render(session);
    rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
    for (let n = 0; n < 120; n += 1) rl.alternateTranscript.push(`row ${n}`);
    rl.flushPaint();
    (rl as unknown as { onWaitingKey(k: string): void }).onWaitingKey('\u001b[5~');
    rl.flushPaint();
    expect(rl.scrolledBack).toBe(true);
    return { rl, top: () => rl.alternatePrevious[0]! };
  }

  // A sign-in's link (six rows) appearing under the history while it was
  // being read moved every row read up by the card's height, and back down
  // when it went.
  it('a sign-in card appearing and going under the history leaves the rows being read where they are', () => {
    const { rl, top } = turnScrolledBack();
    try {
      const read = top();
      const screen = rl.signInScreen('Claude Code');
      screen.show({ url: 'https://claude.example/oauth/authorize?code=true&state=x' } as never);
      rl.flushPaint();
      expect(rl.alternatePrevious.join('\n')).toContain('Sign in to Claude Code');
      expect(top()).toBe(read);
      screen.stop();
      rl.flushPaint();
      expect(rl.alternatePrevious.join('\n')).not.toContain('Sign in to Claude Code');
      expect(top()).toBe(read);
    } finally { rl.close(); }
  });

  it('an approval appearing under the history leaves the rows being read where they are', () => {
    const { rl, top } = turnScrolledBack();
    try {
      const read = top();
      void rl.approval('Run make?', 'make clean');
      rl.flushPaint();
      expect(top()).toBe(read);
    } finally { rl.close(); }
  });

  // The arrows read back over an approval; the Esc that came back from
  // reading denied it and stopped the turn.
  it('Esc read back over an approval returns to the live end and answers nothing; the next Esc denies it', async () => {
    const { rl } = turnScrolledBack();
    try {
      let answer: boolean | 'always' | undefined;
      void rl.approval('Run make?', 'make clean').then((value) => { answer = value; });
      vi.advanceTimersByTime(1000);
      const key = (k: string): void => (rl as unknown as { onWaitingKey(k: string): void }).onWaitingKey(k);
      key('\u001b');
      await Promise.resolve();
      expect(rl.scrolledBack).toBe(false);
      expect(answer).toBeUndefined();
      key('\u001b');
      await Promise.resolve(); await Promise.resolve();
      expect(answer).toBe(false);
    } finally { rl.close(); }
  });

  // A phone's swipe is a run of arrows: the ones past the first row put the
  // last message sent into the composer.
  it('a swipe that reaches the first row does not recall the last message into the composer', () => {
    const rl = new TerminalHarnessPrompter();
    try {
      rl.history.push('earlier message');
      for (let n = 0; n < 60; n += 1) rl.alternateTranscript.push(`row ${n}`);
      const paint = vi.spyOn(rl, 'paint');
      void rl.question('› ');
      for (let n = 0; n < 30; n += 1) stdin.emit('data', Buffer.from('\u001b[A'));
      expect(rl.scrolledBack).toBe(true);
      expect(paint.mock.calls.at(-1)?.[0]).toBe('');
      // Back down to the live end, and Up with nothing typed reads again.
      for (let n = 0; n < 30; n += 1) stdin.emit('data', Buffer.from('\u001b[B'));
      expect(rl.scrolledBack).toBe(false);
      expect(paint.mock.calls.at(-1)?.[0]).toBe('');
    } finally { rl.close(); }
  });
});
