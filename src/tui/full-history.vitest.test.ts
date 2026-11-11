/** The full-screen view scrolls back through the whole conversation: history is rendered from the persisted messages on demand. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';
import { TestScreen } from './inline-screen.vitest-helper.js';
import { HISTORY_DUMP_ROWS } from './prompter/history-dump.js';
import { followEnd } from './prompter/history-window.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

const message = (n: number) => (n % 2 === 0
  ? { role: 'user' as const, content: `question ${n / 2 + 1}` }
  : { role: 'assistant' as const, content: `answer ${(n + 1) / 2}\n\nsecond paragraph of answer ${(n + 1) / 2}` });
const session = (count: number, id = 's1') => ({
  id, route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active',
  messages: Array.from({ length: count }, (_, n) => message(n)),
}) as never;

function setup(rows = 24, columns = 80) {
  const term = new TestScreen(rows, columns);
  Object.assign(process.stdout, { isTTY: true, columns, rows });
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    term.write(String(chunk));
    for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
    return true;
  }) as typeof process.stdout.write;
  const rl = new TerminalHarnessPrompter();
  const settle = (): void => { for (let n = 0; n < 400; n += 1) vi.advanceTimersByTime(1); };
  return { term, rl, settle };
}

const idOf = (rows: readonly string[]): number | undefined => {
  for (const row of rows) { const m = /(?:question|answer|paragraph of answer) (\d+)/.exec(row); if (m) return Number(m[1]); }
  return undefined;
};
const PAGE_UP = '\u001b[5~';
const PAGE_DOWN = '\u001b[6~';
const HOME = '\u001b[1;5H';
const END = '\u001b[1;5F';

describe('scroll-back through a long conversation', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.stubEnv('CLIKCODE_INLINE', ''); vi.stubEnv('STY', ''); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); Object.assign(process.stdout, { isTTY: realTty }); process.stdout.write = realWrite; });

  it('reaches the first message: Home builds the window there from the list, and what is held stays small', () => {
    const { term, rl, settle } = setup();
    try {
      rl.render(session(5000));
      settle();
      const atBottom = rl.scrollWindow.materialised;
      rl.handleScrollKey(HOME);
      settle();
      expect(term.screen()[0]).toContain('› question 1');
      expect(term.screen().join('\n')).toContain('answer 1');
      expect(rl.scrollWindow.first).toBe(0);
      expect(rl.scrollWindow.detached).toBe(true);
      // Nothing between the top and the live end was rendered.
      expect(rl.scrollWindow.materialised).toBeLessThan(80);
      expect(atBottom).toBeLessThan(80);
      expect(rl.scrollWindow.rendered).toBeLessThan(200);
      // Further up is not possible, and does not break anything.
      rl.handleScrollKey(PAGE_UP);
      settle();
      expect(term.screen()[0]).toContain('› question 1');
    } finally { rl.close(); }
  });

  it('scrolls up page by page through unmaterialised history without a jump, all the way, with memory O(viewport)', () => {
    const { term, rl, settle } = setup();
    try {
      rl.render(session(1200));
      settle();
      let peak = rl.scrollWindow.materialised;
      let steps = 0;
      let previous = term.screen().slice(0, rl.alternateAbove);
      // The first page-up leaves the live region, which changes the number of rows the transcript has: compare from the second.
      rl.handleScrollKey(PAGE_UP); settle();
      previous = term.screen().slice(0, rl.alternateAbove);
      for (;;) {
        // A step smaller than the rows the transcript has on screen, so the two views overlap.
        const page = Math.max(1, rl.alternateAbove - 2);
        const before = rl.alternateScrollback;
        rl.scrollTranscript(page);
        settle();
        const above = rl.alternateAbove;
        const now = term.screen().slice(0, above);
        if (rl.alternateScrollback === before) break;
        const moved = Math.min(page, rl.alternateScrollback - before);
        // Exactly `moved` rows came in at the top, and the rest is what was on screen: no jump.
        expect(now.slice(moved)).toEqual(previous.slice(0, above - moved));
        previous = now;
        peak = Math.max(peak, rl.scrollWindow.materialised);
        steps += 1;
        if (steps > 3000) throw new Error('never reached the top');
      }
      expect(term.screen()[0]).toContain('› question 1');
      expect(steps).toBeGreaterThan(100);
      expect(peak).toBeLessThan(200);
    } finally { rl.close(); }
  });

  it('holds a bounded number of messages at the top, the middle and the bottom of 5000', () => {
    const { term, rl, settle } = setup();
    try {
      rl.render(session(5000));
      settle();
      const held: Record<string, number> = { bottom: rl.scrollWindow.materialised };
      // Already reading back when the long jump comes: what the last frame measured is not what the view is held against.
      rl.scrollTranscript(40);
      settle();
      rl.scrollTranscript(12000);
      settle();
      expect(idOf(term.screen())).toBeGreaterThan(500);
      expect(idOf(term.screen())).toBeLessThan(2000);
      held.middle = rl.scrollWindow.materialised;
      expect(held.middle).toBeGreaterThan(0);
      rl.handleScrollKey(HOME);
      settle();
      held.top = rl.scrollWindow.materialised;
      for (const [where, count] of Object.entries(held)) expect(count, where).toBeLessThan(100);
      expect(rl.alternateTranscript.length).toBeLessThan(500);
    } finally { rl.close(); }
  });

  it('End returns to the live bottom, written from the list again', () => {
    const { term, rl, settle } = setup();
    try {
      rl.render(session(3000));
      settle();
      rl.handleScrollKey(HOME);
      settle();
      expect(rl.scrolledBack).toBe(true);
      rl.handleScrollKey(END);
      settle();
      expect(rl.scrolledBack).toBe(false);
      expect(rl.scrollWindow.detached).toBe(false);
      expect(term.screen().join('\n')).toContain('answer 1500');
    } finally { rl.close(); }
  });

  it('returning to the live end draws through the one paint scheduler: repeated returns do not pile up frames', () => {
    const { term, rl, settle } = setup();
    try {
      rl.render(session(3000));
      settle();
      rl.handleScrollKey(HOME);
      settle();
      const repaint = vi.spyOn(rl, 'repaint');
      expect(followEnd(rl)).toBe(true);
      const timers = vi.getTimerCount();
      rl.schedulePaint(0);
      rl.schedulePaint(0);
      expect(vi.getTimerCount()).toBe(timers);
      vi.advanceTimersByTime(1);
      expect(repaint).toHaveBeenCalledTimes(1);
      settle();
      expect(term.screen().join('\n')).toContain('answer 1500');
    } finally { rl.close(); }
  });

  it('scrolling down from far back arrives at the live end by itself', () => {
    const { term, rl, settle } = setup();
    try {
      rl.render(session(400));
      settle();
      rl.handleScrollKey(HOME);
      settle();
      let steps = 0;
      while (rl.scrolledBack && steps < 2000) { rl.handleScrollKey(PAGE_DOWN); settle(); steps += 1; }
      expect(rl.scrolledBack).toBe(false);
      expect(term.screen().join('\n')).toContain('answer 200');
    } finally { rl.close(); }
  });

  it('keeps the message at the top of the view when the width changes', () => {
    const { term, rl, settle } = setup(24, 100);
    try {
      rl.render(session(3000));
      settle();
      rl.scrollTranscript(20000);
      settle();
      const before = idOf(term.screen());
      expect(before).toBeDefined();
      Object.assign(process.stdout, { columns: 70 });
      (rl as unknown as { onResize(): void }).onResize();
      settle();
      for (let n = 0; n < 5; n += 1) settle();
      const after = idOf(term.screen());
      expect(rl.scrolledBack).toBe(true);
      expect(Math.abs((after ?? -100) - (before ?? 0))).toBeLessThanOrEqual(1);
    } finally { rl.close(); }
  });

  it('does not move the view when messages arrive at the end while it is scrolled back, near or far', () => {
    for (const back of [60, 9000]) {
      const { term, rl, settle } = setup();
      try {
        const s = session(3000) as unknown as { messages: Array<{ role: string; content: string }> };
        rl.render(s as never);
        settle();
        rl.scrollTranscript(back);
        settle();
        const before = term.screen().slice(0, rl.alternateAbove);
        for (let n = 0; n < 6; n += 1) {
          s.messages.push({ role: n % 2 ? 'assistant' : 'user', content: `new ${n}\n\nmore of ${n}` });
          rl.render(s as never);
          settle();
        }
        expect(term.screen().slice(0, rl.alternateAbove), `back ${back}`).toEqual(before);
      } finally { rl.close(); }
    }
  });

  it('opens another conversation at its live end', () => {
    const { term, rl, settle } = setup();
    try {
      rl.render(session(2000, 'a'));
      settle();
      rl.handleScrollKey(HOME);
      settle();
      rl.render(session(50, 'b'));
      settle();
      expect(rl.scrolledBack).toBe(false);
      expect(rl.scrollWindow.detached).toBe(false);
      expect(term.screen().join('\n')).toContain('answer 25');
    } finally { rl.close(); }
  });

  it('keeps rendering the batches a frame had no time for, even when the frame they follow changed nothing on screen', () => {
    const { rl, settle } = setup();
    // Every frame's budget is spent after one batch: the rest is owed to the frames that follow.
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
    try {
      rl.render(session(2000));
      settle();
      // To the top of what is held: the rows above it are a few batches away.
      rl.scrollTranscript(rl.alternateTranscript.length);
      settle();
      expect(rl.scrollWindow.more).toBe(false);
    } finally { now.mockRestore(); rl.close(); }
  });

  it('renders a bounded number of messages per frame: work units, not time', () => {
    const { rl, settle } = setup();
    try {
      rl.render(session(2000));
      settle();
      expect(rl.alternateTranscript.length).toBeLessThan(400);
      const start = rl.scrollWindow.rendered;
      let worst = 0;
      for (let n = 0; n < 60; n += 1) {
        const before = rl.scrollWindow.rendered;
        rl.handleScrollKey(PAGE_UP);
        // One frame, no timers run: whatever it rendered is what a frame costs.
        worst = Math.max(worst, rl.scrollWindow.rendered - before);
      }
      expect(worst).toBeLessThanOrEqual(120);
      expect(rl.scrollWindow.rendered - start).toBeLessThan(2000);
    } finally { rl.close(); }
  });
});

describe('the history written under the shell when the screen is left', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.stubEnv('CLIKCODE_INLINE', ''); vi.stubEnv('STY', ''); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); Object.assign(process.stdout, { isTTY: realTty }); process.stdout.write = realWrite; });
  const rowsOf = (text: string): string[] => text.replaceAll('\u001b[?7h', '').split('\u001b[0m\r\n').slice(0, -1);

  it('writes the whole conversation when it is at most 20000 rows', () => {
    const { rl, settle } = setup();
    try {
      rl.render(session(1000));
      settle();
      const out = rowsOf(rl.takeHistoryDump());
      expect(out.length).toBeLessThanOrEqual(HISTORY_DUMP_ROWS);
      expect(out.some((row) => row.includes('earlier row'))).toBe(false);
      expect(out[0]).toBe('› question 1');
      expect(out.join('\n')).toContain('answer 500');
      expect(out.join('\n')).toContain('question 250');
      expect(rl.takeHistoryDump()).toBe('');
    } finally { rl.close(); }
  });

  it('writes the last 20000 rows and a note for a longer one', () => {
    const { rl, settle } = setup();
    try {
      rl.render(session(8000));
      settle();
      const out = rowsOf(rl.takeHistoryDump());
      expect(out).toHaveLength(HISTORY_DUMP_ROWS + 1);
      expect(out[0]).toMatch(/earlier rows not shown; `clikcode sessions resume s1` reopens the whole conversation/);
      expect(out.at(-1)).toBe('');
      expect(out.join('\n')).toContain('answer 4000');
    } finally { rl.close(); }
  });

  it('writes only what is new after a suspend, a new width, and more messages: nothing twice', () => {
    const { rl, settle } = setup();
    try {
      const s = session(40) as unknown as { messages: Array<{ role: string; content: string }> };
      rl.render(s as never);
      settle();
      const first = rowsOf(rl.takeHistoryDump());
      expect(first.join('\n')).toContain('answer 20');
      // The conversation is written again at another width: what the dump holds is by message, so nothing repeats.
      Object.assign(process.stdout, { columns: 60 });
      (rl as unknown as { onResize(): void }).onResize();
      settle();
      expect(rl.takeHistoryDump()).toBe('');
      s.messages.push({ role: 'user', content: 'one more question' }, { role: 'assistant', content: 'one more answer' });
      rl.render(s as never);
      settle();
      const second = rowsOf(rl.takeHistoryDump());
      expect(second.join('\n')).toContain('one more question');
      expect(second.join('\n')).not.toContain('answer 20');
      expect(rl.takeHistoryDump()).toBe('');
    } finally { rl.close(); }
  });
});
