/** A frame that retires one line while the answer streams is a shift of the transcript by one row: the terminal does the
 * shift and only the exposed row and the changed live rows are written, not fifty rows of the screen. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';
import { TestScreen } from './inline-screen.vitest-helper.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
const ROWS = 57;
const COLS = 80;
const row = (n: number): string => `transcript row ${n} ${'.'.repeat(45)}`;

describe('streaming in full-screen mode', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.stubEnv('CLIKCODE_INLINE', ''); vi.stubEnv("STY", ""); });
  afterEach(() => {
    vi.useRealTimers(); vi.unstubAllEnvs();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  function open(): { rl: TerminalHarnessPrompter; term: TestScreen; writes: string[] } {
    const term = new TestScreen(ROWS, COLS);
    const writes: string[] = [];
    Object.assign(process.stdout, { isTTY: true, columns: COLS, rows: ROWS });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      writes.push(String(chunk)); term.write(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    return { rl: new TerminalHarnessPrompter(), term, writes };
  }

  const live = (tick: number): string[] => [
    `streaming answer tail ${tick}`, '', 'tool row a', 'tool row b', '> composer', 'status line', `clock ${tick}`,
  ];
  const frame = (rl: TerminalHarnessPrompter, finished: string[], tick: number): void => {
    rl.renderFrame(finished, live(tick), 4, 12, false);
    vi.advanceTimersByTime(5);
  };

  it('writes under a kilobyte for a frame that retires one line over a 50-row transcript, and the screen is right', () => {
    const { rl, term, writes } = open();
    try {
      frame(rl, Array.from({ length: 50 }, (_, n) => row(n)), 0);
      const before = writes.length;
      frame(rl, [row(50)], 1);
      const bytes = writes.slice(before).join('').length;
      expect(bytes).toBeLessThan(1000);
      const screen = term.screen();
      expect(screen.slice(0, ROWS - 7).filter((r) => r)).toEqual(Array.from({ length: 51 }, (_, n) => row(n)).slice(-(ROWS - 7)));
      expect(screen.slice(-7)).toEqual(live(1).map((r) => r.trimEnd()));
    } finally { rl.close(); }
  });

  it('a run of retired lines keeps every row exact on screen', () => {
    const { rl, term } = open();
    try {
      frame(rl, Array.from({ length: 60 }, (_, n) => row(n)), 0);
      for (let n = 60; n < 90; n += 1) frame(rl, [row(n)], n);
      const want = Array.from({ length: 90 }, (_, n) => row(n)).slice(-(ROWS - 7));
      expect(term.screen().slice(0, ROWS - 7)).toEqual(want);
    } finally { rl.close(); }
  });
});
