/** A swipe only scrolls; an arrow key recalls history and moves the draft; nothing a swipe sends ever clears the composer. */
import { stdin } from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEP_STDIN_FLOWING } from './input-decoder.js';
import { TerminalHarnessPrompter } from './prompter.js';
import { sessionModesOn } from './modes.js';
import { terminalTeardown } from './restore.js';
import { SWIPE_BURST_MS, SWIPE_TAIL_MS } from './swipe-arrows.js';

const realTty = process.stdout.isTTY;
const realInTty = stdin.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
const UP = '\u001b[A';
const DOWN = '\u001b[B';

function session() {
  const rl = new TerminalHarnessPrompter();
  rl.history.push('first message', 'second message');
  const paint = vi.spyOn(rl, 'paint').mockImplementation(() => {});
  const scroll = vi.spyOn(rl, 'scrollTranscript').mockImplementation(() => true);
  const asked = rl.question('› ');
  const send = (text: string): void => { stdin.emit('data', Buffer.from(text)); };
  // A person pressing a key: one read, and the next one a while later.
  const press = (text: string): void => { send(text); vi.advanceTimersByTime(SWIPE_BURST_MS + 40); };
  const shown = (): string => paint.mock.calls.at(-1)![0] as string;
  return { rl, asked, send, press, shown, scroll };
}

describe('swipe and arrow keys', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
    process.stdout.write = (() => true) as typeof process.stdout.write;
    stdin.on('data', KEEP_STDIN_FLOWING);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    stdin.off('data', KEEP_STDIN_FLOWING); stdin.pause();
    Object.assign(process.stdout, { isTTY: realTty });
    Object.assign(stdin, { isTTY: realInTty });
    process.stdout.write = realWrite;
  });

  it('Down on a typed draft keeps it (it used to load history[length], nothing: the composer cleared)', () => {
    const { rl, press, shown } = session();
    try {
      press('half-written thought');
      press(DOWN);
      expect(shown()).toBe('half-written thought');
      press('\u000e'); // Ctrl+N, the same step
      expect(shown()).toBe('half-written thought');
    } finally { rl.close(); }
  });

  it('a swipe (a burst of arrows in one read) scrolls and leaves the draft alone', () => {
    const { rl, send, press, shown, scroll } = session();
    try {
      press('half-written thought');
      send(`${DOWN}${DOWN}${DOWN}`);
      send(`${UP}${UP}${UP}${UP}`);
      vi.advanceTimersByTime(SWIPE_BURST_MS + 40);
      expect(shown()).toBe('half-written thought');
      expect(scroll).toHaveBeenCalledTimes(7);
    } finally { rl.close(); }
  });

  it('a swipe while browsing /search mentions scrolls the conversation; Up pressed as a key steps to the previous mention', async () => {
    const rl = new TerminalHarnessPrompter();
    const scroll = vi.spyOn(rl, 'scrollTranscript').mockImplementation(() => true);
    try {
      let action: string | undefined;
      void rl.mentionKey().then((value) => { action = value; });
      stdin.emit('data', Buffer.from(`${UP}${UP}${UP}`));
      vi.advanceTimersByTime(SWIPE_BURST_MS + 40);
      await Promise.resolve();
      expect(action).toBeUndefined();
      expect(scroll).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(1000);
      stdin.emit('data', Buffer.from(UP));
      vi.advanceTimersByTime(SWIPE_BURST_MS + 40);
      await Promise.resolve();
      expect(action).toBe('previous');
    } finally { rl.close(); }
  });

  it('a swipe split across reads (60 arrows a second) is still a swipe, and so is its slow momentum tail', () => {
    const { rl, send, press, shown, scroll } = session();
    try {
      press('draft');
      for (let index = 0; index < 5; index += 1) { send(UP); vi.advanceTimersByTime(16); }
      // The coast slowing down: arrows further apart than a burst, inside the tail.
      vi.advanceTimersByTime(150); send(UP);
      vi.advanceTimersByTime(300); send(DOWN);
      vi.advanceTimersByTime(SWIPE_BURST_MS + 40);
      expect(shown()).toBe('draft');
      expect(scroll).toHaveBeenCalledTimes(7);
      // Well after the swipe, a key press is a key press again.
      vi.advanceTimersByTime(SWIPE_TAIL_MS);
      press(UP);
      expect(shown()).toBe('second message');
    } finally { rl.close(); }
  });

  it('arrow keys recall history on an empty composer, and Down past the newest brings the (empty) draft back', () => {
    const { rl, press, shown, scroll } = session();
    try {
      press(UP);
      expect(shown()).toBe('second message');
      press(UP);
      expect(shown()).toBe('first message');
      press(DOWN);
      press(DOWN);
      expect(shown()).toBe('');
      press(DOWN);
      expect(shown()).toBe('');
      expect(scroll).not.toHaveBeenCalled();
    } finally { rl.close(); }
  });

  it('a key typed right after a held arrow keeps its order (the arrow goes first, as a key)', async () => {
    const { rl, asked, send, press } = session();
    try {
      send(UP);
      send('!');
      press('\r');
      await expect(asked).resolves.toBe('second message!');
    } finally { rl.close(); }
  });

  describe('the ClikDeploy phone page (CLIKDEPLOY_CLIENT=mobile): wheel reports', () => {
    beforeEach(() => { vi.stubEnv('CLIKDEPLOY_CLIENT', 'mobile'); vi.stubEnv('CLIKCODE_INLINE', ''); vi.stubEnv('CLIKCODE_MOUSE', ''); });

    it('asks for wheel reporting (press + SGR only) instead of alternate scroll, clears an inherited one, and gives it all back', () => {
      const on = sessionModesOn();
      expect(on).toContain('\u001b[?1000h');
      expect(on).toContain('\u001b[?1006h');
      expect(on).not.toMatch(/\?100[23]h|\?1007h/);
      expect(on).toContain('\u001b[?1007l');
      const off = terminalTeardown(true);
      expect(off).toContain('\u001b[?1000l');
      expect(off).toContain('\u001b[?1006l');
    });

    it('arrows are keys at once (no burst guessing), a wheel scrolls, and a tap\'s button report does nothing', () => {
      const { rl, send, shown, scroll } = session();
      try {
        send('draft');
        send('\u001b[<64;10;5M\u001b[<64;10;5M\u001b[<65;10;5M');
        vi.runOnlyPendingTimers();
        expect(shown()).toBe('draft');
        expect(rl.selection).toBeUndefined();
        send('\u001b[<0;10;5M\u001b[<0;10;5m');
        expect(shown()).toBe('draft');
        expect(rl.selection).toBeUndefined();
        const scrolled = scroll.mock.calls.length;
        send(UP);
        expect(shown()).toBe('second message');
        send(UP);
        expect(shown()).toBe('first message');
        send(DOWN);
        send(DOWN);
        expect(shown()).toBe('draft');
        expect(scroll).toHaveBeenCalledTimes(scrolled);
      } finally { rl.close(); }
    });
  });
});
