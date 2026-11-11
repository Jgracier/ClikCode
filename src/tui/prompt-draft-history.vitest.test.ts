/** Up recalls history over what is typed; Down past the newest entry brings the typed draft back. */
import { stdin } from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEP_STDIN_FLOWING } from './input-decoder.js';
import { TerminalHarnessPrompter } from './prompter.js';
import { SWIPE_BURST_MS } from './swipe-arrows.js';

const realTty = process.stdout.isTTY;
const realInTty = stdin.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

describe('history recall over a draft', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
    process.stdout.write = (() => true) as typeof process.stdout.write;
    stdin.on('data', KEEP_STDIN_FLOWING);
  });
  afterEach(() => {
    vi.useRealTimers();
    stdin.off('data', KEEP_STDIN_FLOWING); stdin.pause();
    Object.assign(process.stdout, { isTTY: realTty });
    Object.assign(stdin, { isTTY: realInTty });
    process.stdout.write = realWrite;
  });

  it('keeps the draft: Up shows the last message, Down restores what was typed', async () => {
    const rl = new TerminalHarnessPrompter();
    try {
      rl.history.push('first message', 'second message');
      const paint = vi.spyOn(rl, 'paint').mockImplementation(() => {});
      const asked = rl.question('› ');
      // A key press: one read, then a pause (arrows closer together than a burst are a swipe: swipe-arrows.ts).
      const send = (text: string): void => { stdin.emit('data', Buffer.from(text)); vi.advanceTimersByTime(SWIPE_BURST_MS + 40); };
      const shown = (): string => paint.mock.calls.at(-1)![0] as string;
      send('half-written thought');
      expect(shown()).toBe('half-written thought');
      send('\u001b[A');
      expect(shown()).toBe('second message');
      send('\u001b[A');
      expect(shown()).toBe('first message');
      send('\u001b[B');
      expect(shown()).toBe('second message');
      send('\u001b[B');
      expect(shown()).toBe('half-written thought');
      send('\r');
      await expect(asked).resolves.toBe('half-written thought');
    } finally { rl.close(); }
  });
});
