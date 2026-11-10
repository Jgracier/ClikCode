/** Rows past the cap on the kept transcript are gone from the view; the first row says so. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';
import { TestScreen } from './inline-screen.vitest-helper.js';
import { ALTERNATE_TRANSCRIPT_ROWS } from './prompter/state.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

describe('the cap on the scroll-back', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.stubEnv('CLIKCODE_INLINE', ''); vi.stubEnv('STY', ''); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); Object.assign(process.stdout, { isTTY: realTty }); process.stdout.write = realWrite; });

  it('puts a notice with the count first, keeps its count as more is trimmed, and shows it at the top of the scroll', () => {
    const term = new TestScreen(20, 80);
    Object.assign(process.stdout, { isTTY: true, columns: 80, rows: 20 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      term.write(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter();
    const frame = (rows: string[]): void => { rl.renderFrame(rows, ['> composer', 'status'], 0, 4, false); vi.advanceTimersByTime(5); };
    try {
      frame(Array.from({ length: ALTERNATE_TRANSCRIPT_ROWS + 100 }, (_, n) => `row ${n}`));
      expect(rl.alternateTranscript).toHaveLength(ALTERNATE_TRANSCRIPT_ROWS);
      // 100 rows trimmed, and the oldest one left makes room for the notice.
      expect(rl.alternateTranscript[0]).toContain('101 earlier rows not shown; /resume reopens the whole conversation');
      expect(rl.alternateTranscript[1]).toBe('row 101');
      frame(Array.from({ length: 10 }, (_, n) => `more ${n}`));
      expect(rl.alternateTranscript[0]).toContain('111 earlier rows not shown');
      expect(rl.alternateTranscript.filter((r) => r.includes('earlier rows not shown'))).toHaveLength(1);
      // Scrolled to the very top, the screen's first row is the notice.
      rl.scrollTranscript(Number.MAX_SAFE_INTEGER);
      frame([]);
      expect(term.screen()[0]).toContain('111 earlier rows not shown');
    } finally { rl.close(); }
  });
});
