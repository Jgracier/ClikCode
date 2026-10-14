/** The turn's motion: the glyph and the label shimmer step on one fast clock,
 * and stand still whenever the turn waits on the user or motion is reduced. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTurnTickMs, startTurnClock, turnAnimating } from '../harness/protocol/activity-view.js';
import { SHIMMER_STRIDE, SPIN_MS, shimmerCycleMs, SHIMMER_WIDTH } from '../harness/protocol/timings.js';
import { shimmerLevels } from '../harness/protocol/turn-flow.js';
import { TerminalHarnessPrompter } from './prompter.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('the cadence constants', () => {
  it('steps the glyph at most every 120 ms and the shimmer one cell per step', () => {
    expect(SPIN_MS).toBeLessThanOrEqual(120);
    expect(SHIMMER_STRIDE).toBe(1);
    // One sweep: every cell of the label plus the band either side, a cell a step.
    expect(shimmerCycleMs(10)).toBe((10 + SHIMMER_WIDTH * 2) * SPIN_MS);
    // Consecutive steps move the highlight exactly one cell.
    const centre = (frame: number): number => shimmerLevels(30, frame * SHIMMER_STRIDE).indexOf(1);
    expect(centre(12) - centre(11)).toBe(1);
  });

  it('ticks once a second, not at the spinner step, while the turn waits on the user', () => {
    const clock = startTurnClock(0);
    expect(nextTurnTickMs(clock, 100, turnAnimating({ toolsRunning: false, approval: false }))).toBe(SPIN_MS);
    const blocked = nextTurnTickMs(clock, 100, turnAnimating({ toolsRunning: true, approval: true }));
    expect(blocked).toBeGreaterThan(800);
  });
});

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
const realMotion = process.env.CLIKCODE_REDUCED_MOTION;

function open(): { rl: TerminalHarnessPrompter; line: () => string; frame: () => number } {
  Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
  process.stdout.write = (() => true) as typeof process.stdout.write;
  const rl = new TerminalHarnessPrompter();
  rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
  const inner = rl as unknown as { turn: unknown; waitingLine(turn: unknown, width: number): string; waitingFrame: number };
  return { rl, line: () => strip(inner.waitingLine(inner.turn, 100)), frame: () => inner.waitingFrame };
}

describe('the status line motion', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); delete process.env.CLIKCODE_REDUCED_MOTION; });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
    if (realMotion === undefined) delete process.env.CLIKCODE_REDUCED_MOTION; else process.env.CLIKCODE_REDUCED_MOTION = realMotion;
  });

  it('advances the shared frame at the spinner step', () => {
    const { rl, frame } = open();
    try {
      const start = frame();
      vi.advanceTimersByTime(SPIN_MS * 10 + 1);
      expect(frame() - start).toBe(10);
    } finally { rl.close(); }
  });

  it('holds the frame still under reduced motion', () => {
    process.env.CLIKCODE_REDUCED_MOTION = '1';
    const { rl, frame } = open();
    try {
      vi.advanceTimersByTime(SPIN_MS * 10 + 1);
      expect(frame()).toBe(0);
    } finally { rl.close(); }
  });

  it('holds the frame still, with a dot and no clock, while an approval waits', () => {
    const { rl, frame, line } = open();
    try {
      void rl.approval('Run make?', 'make clean');
      vi.advanceTimersByTime(250);
      const held = frame();
      vi.advanceTimersByTime(SPIN_MS * 10);
      expect(frame()).toBe(held);
      expect(line()).toContain('● waiting for you');
    } finally { rl.close(); }
  });

  it('shows the spinner, one word and the clock: no token meter, the key that stops it', () => {
    const { rl, line } = open();
    try {
      rl.response('x'.repeat(4000));
      (rl as unknown as { setTurnUsage(u: { output: number }): void }).setTurnUsage({ output: 3400 });
      vi.advanceTimersByTime(SPIN_MS * 60);
      expect(line()).toMatch(/(thinking|writing) · \d+s · esc stop$/);
      expect(line()).not.toContain('tokens');
    } finally { rl.close(); }
  });

  it('says nothing about tokens while the turn waits on the user', () => {
    const { rl, line } = open();
    try {
      rl.response('x'.repeat(4000));
      vi.advanceTimersByTime(SPIN_MS * 40);
      void rl.approval('Run make?', 'make clean');
      expect(line()).toContain('waiting for you');
      expect(line()).not.toContain('tokens');
    } finally { rl.close(); }
  });
});

describe('an approval on a short terminal', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  /** What the screen shows after a frame: the writes since `start`, replayed
   * naively as text (enough to ask "is the question on it"). */
  function screenAt(rows: number, ask: (rl: TerminalHarnessPrompter) => void, label = 'thinking'): string {
    const written: string[] = [];
    Object.assign(process.stdout, { isTTY: true, columns: 80, rows });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter();
    try {
      rl.render({
        id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [],
      } as never);
      rl.startWaiting(label, () => undefined, async () => ({ kind: 'sent' }) as never);
      ask(rl);
      vi.advanceTimersByTime(300);
      return strip(written.join(''));
    } finally { rl.close(); }
  }

  for (const rows of [5, 6, 7, 8, 12]) {
    it(`draws the approval and its keys at ${rows} rows`, () => {
      const screen = screenAt(rows, (rl) => { void rl.approval('make clean', '$ make clean'); });
      expect(screen).toContain('[y]');
      expect(screen).toContain('[n]');
      expect(screen).toContain('waiting for you');
    });

    it(`draws a question and its keys at ${rows} rows`, () => {
      const screen = screenAt(rows, (rl) => {
        void rl.askQuestions({ title: 'Codex asks', questions: [{ id: 'db', prompt: 'Which database?', options: [{ label: 'Postgres' }, { label: 'MySQL' }, { label: 'SQLite' }] }] });
      });
      expect(screen).toContain('[enter]');
    });
  }

  it('keeps a one-row status on a viewport too short for the band', () => {
    const screen = screenAt(4, () => undefined, 'pondering');
    expect(screen).toContain('pondering');
  });
});

describe('answering an approval', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  type Window = TerminalHarnessPrompter & { key(k: string): void; screen(): string; status(): string };
  /** A prompter on a 100x30 screen, with `onWaitingKey` and what has been written so far. */
  function window(): Window {
    const written: string[] = [];
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 30 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter() as unknown as Window;
    rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
    rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
    const inner = rl as unknown as { onWaitingKey(k: string): void; turn: unknown; waitingLine(turn: unknown, width: number): string };
    rl.key = (k) => inner.onWaitingKey(k);
    rl.screen = () => strip(written.join(''));
    rl.status = () => strip(inner.waitingLine(inner.turn, 100));
    return rl;
  }
  const after = (ms: number): void => { vi.advanceTimersByTime(ms); };

  it('leaves a settled row for each decision, in the words of what was decided', async () => {
    const rl = window();
    try {
      rl.response('Cleaning up.');
      const first = rl.approval('make clean', '$ make clean');
      after(1000);
      rl.key('n');
      await expect(first).resolves.toBe(false);
      after(100);
      const second = rl.approval('make build', '$ make build');
      after(1000);
      rl.key('y');
      await expect(second).resolves.toBe(true);
      after(100);
      expect(rl.screen()).toContain('✗ denied make clean');
      expect(rl.screen()).toContain('✓ approved make build');
    } finally { rl.close(); }
  });

  it('says what it was told when the answer is "tell it instead"', async () => {
    const rl = window();
    try {
      rl.response('Releasing.');
      const asked = rl.approval('make release', '$ make release');
      after(1000);
      rl.key('t');
      for (const ch of 'use pnpm instead') rl.key(ch);
      rl.key('\r');
      await expect(asked).resolves.toBe(false);
      after(100);
      expect(rl.screen()).toContain('↳ told: use pnpm instead');
    } finally { rl.close(); }
  });

  it('does not keep the vendor\'s "waiting for your approval" phase as the status after the answer', async () => {
    const rl = window();
    try {
      rl.phase('waiting for your approval: make clean');
      const asked = rl.approval('make clean', '$ make clean');
      after(1000);
      rl.key('y');
      await asked;
      after(100);
      expect(rl.status()).not.toContain('waiting for');
      expect(rl.status()).toMatch(/thinking|writing/);
    } finally { rl.close(); }
  });
});

describe('a slash command typed while the turn runs', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  async function typeCommand(line: string, result: Record<string, unknown>): Promise<string> {
    const written: string[] = [];
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 30 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter();
    try {
      rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
      rl.startWaiting('thinking', () => undefined, async () => ({ disposition: 'queued', submission: { id: 'a', text: 'x', submittedAt: '' } }) as never,
        async (text) => ({ disposition: 'command', submission: { id: 'c', text, submittedAt: '' }, ...result }) as never);
      const key = (rl as unknown as { onWaitingKey(k: string): void }).onWaitingKey.bind(rl);
      for (const ch of line) key(ch);
      key('\r');
      await vi.advanceTimersByTimeAsync(100);
      return strip(written.join(''));
    } finally { rl.close(); }
  }

  it('says nothing of what became of it: the footer shows a model, the turn\'s end shows the rest', async () => {
    expect(await typeCommand('/model sonnet', { commandOutcome: 'applied' })).not.toContain('applied');
    expect(await typeCommand('/stats', { commandOutcome: 'later' })).not.toContain('runs when this turn ends');
  });
});
