/** Standard 11: what a turn drew live is drawn when its conversation is
 * reopened, in the same order. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';
import type { HarnessSession, TranscriptMessage, TurnMark } from '../session/model.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

/** The text a reopened conversation puts on the screen, in drawing order. */
function reopened(messages: TranscriptMessage[]): string {
  const written: string[] = [];
  Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 60 });
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    written.push(String(chunk));
    for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
    return true;
  }) as typeof process.stdout.write;
  const rl = new TerminalHarnessPrompter();
  try {
    rl.render({
      id: 's', route: 'local', accountId: null, provider: null, model: null, effort: 'medium',
      createdAt: '', updatedAt: '', status: 'active', messages,
    } as HarnessSession as never);
    vi.advanceTimersByTime(300);
    return strip(written.join('')).replace(/\s+/g, ' ');
  } finally { rl.close(); }
}

const index = (screen: string, needle: string): number => screen.indexOf(needle);

describe('a reopened conversation draws the turn\'s durable marks', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  const first = 'Let me look.\n\n';
  const answer = `${first}Found it.\n\nAll done.`;
  const marks: NonNullable<TranscriptMessage['marks']> = [
    { kind: 'thought', id: 't1', seq: 1, responseOffset: 0, durationMs: 4200, heading: 'Inspecting the parser' },
    { kind: 'plan', id: 'plan', seq: 3, responseOffset: first.length, entries: [{ content: 'Read the lexer', status: 'completed' }, { content: 'Fix the bug', status: 'completed' }] },
    { kind: 'notice', id: 'n1', seq: 4, responseOffset: first.length, message: 'Switched to the work account' },
    { kind: 'outcome', id: 'o1', seq: 5, responseOffset: first.length, outcome: 'denied', label: 'make clean' },
    { kind: 'thought', id: 't2', seq: 6, responseOffset: answer.length, durationMs: 2000 },
  ];
  const activities: NonNullable<TranscriptMessage['activities']> = [
    { event: { kind: 'tool-done', label: 'Read src/lexer.ts', id: 'c1', category: 'read', seq: 2 }, responseOffset: first.length },
  ];
  const turn = (extra: Partial<TranscriptMessage>): TranscriptMessage[] => [
    { role: 'user', content: 'fix the parser' },
    { role: 'assistant', content: answer, ...extra },
  ];

  it('draws thoughts, plan, notice and outcome at their place among calls and prose', () => {
    const rows = reopened(turn({ marks, activities }));
    for (const needle of ['✻ Thought for 4s · Inspecting the parser', 'Let me look.', 'Read', 'Plan · 2/2 done', '☑ Fix the bug',
      'Switched to the work account', '✗ denied make clean', 'Found it.', '✻ Thought for 2s']) {
      expect(index(rows, needle), needle).toBeGreaterThanOrEqual(0);
    }
    const order = ['✻ Thought for 4s', 'Let me look.', 'Read src/lexer.ts', 'Plan · 2/2 done', 'Switched to', '✗ denied', 'Found it.', 'All done.', '✻ Thought for 2s']
      .map((needle) => index(rows, needle));
    expect(order.every((at, position) => at >= 0 && (position === 0 || at > order[position - 1]!))).toBe(true);
  });

  it('settles the denied call\'s own row with the decision: one event is one row (standard 8)', () => {
    const rows = reopened(turn({
      activities: [{ event: { kind: 'tool-error', label: '$ make clean', id: 'c2', category: 'run', seq: 2 }, responseOffset: first.length }],
      marks: [{ kind: 'outcome', id: 'outcome:ap1', seq: 3, responseOffset: first.length, outcome: 'denied', label: 'make clean', callId: 'c2' }],
    }));
    expect(rows.match(/make clean/g), rows).toHaveLength(1);
    expect(rows).toContain('✗ denied make clean');
  });

  it('a decision with no call id stays a row of its own beside the call (legacy marks)', () => {
    const rows = reopened(turn({
      activities: [{ event: { kind: 'tool-error', label: '$ make clean', id: 'c2', category: 'run', seq: 2 }, responseOffset: first.length }],
      marks: [{ kind: 'outcome', id: 'outcome:ap1', seq: 3, responseOffset: first.length, outcome: 'denied', label: 'make clean' }],
    }));
    expect(rows.match(/make clean/g)).toHaveLength(2);
  });

  it('draws a legacy message with no marks exactly as before', () => {
    const withMarks = reopened(turn({ activities }));
    expect(withMarks).not.toContain('Thought for');
    expect(withMarks).not.toContain('Plan');
    expect(index(withMarks, 'Let me look.')).toBeLessThan(index(withMarks, 'Read src/lexer.ts'));
  });

  it('draws a turn that only thought and was stopped', () => {
    const rows = reopened([
      { role: 'user', content: 'fix the parser' },
      { role: 'assistant', content: '', marks: [{ kind: 'thought', id: 't', seq: 1, responseOffset: 0, durationMs: 7000, heading: 'Reading the code' }] },
    ]);
    expect(index(rows, '✻ Thought for 7s · Reading the code')).toBeGreaterThanOrEqual(0);
  });
});

describe('a window joining a running turn', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  function joined(draw: (rl: TerminalHarnessPrompter) => void): string {
    const written: string[] = [];
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter();
    try {
      rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
      rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
      draw(rl);
      vi.advanceTimersByTime(400);
      return strip(written.join('')).replace(/\s+/g, ' ');
    } finally { rl.close(); }
  }

  const settled: TurnMark = { kind: 'thought', id: 'thought:r1', seq: 1, responseOffset: 0, durationMs: 5000, heading: 'Reading the parser' };

  it('draws the settled thoughts of the turn so far, once however often the snapshot repeats', () => {
    const screen = joined((rl) => {
      rl.response('Looking at it. ', 'replace');
      rl.joinMark(settled);
      rl.joinMark(settled);
      rl.joinMark({ kind: 'notice', id: 'notice:2', seq: 2, responseOffset: 15, message: 'Switched to work' });
    });
    expect(screen.match(/Thought for 5s · Reading the parser/g)).toHaveLength(1);
    expect(screen).toContain('Switched to work');
  });

  it('a decision another window made settles the call row it names, not a second row', () => {
    const screen = joined((rl) => {
      rl.response('Looking at it. ', 'replace');
      rl.activityEvent({ kind: 'tool-start', label: '$ make clean', id: 'c2', category: 'run', seq: 1 } as never, { index: 0, responseOffset: 15 });
      rl.joinMark({ kind: 'outcome', id: 'outcome:ap1', seq: 2, responseOffset: 15, outcome: 'denied', label: 'make clean', callId: 'c2' });
    });
    expect(screen.match(/make clean/g), screen).toHaveLength(1);
    expect(screen).toContain('✗ denied make clean');
  });

  it('draws nothing again for a row its own live path already drew', () => {
    const screen = joined((rl) => {
      rl.response('Looking at it. ', 'replace');
      rl.markDrawn('notice:2');
      rl.joinMark({ kind: 'notice', id: 'notice:2', seq: 2, responseOffset: 15, message: 'Switched to work' });
    });
    expect(screen).not.toContain('Switched to work');
  });
});

describe('a compaction ClikCode ran itself', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  it('is drawn as its notice, not as a /compact the user typed; a typed one stays theirs', () => {
    const why = 'Compacted automatically: the context was 670k tokens, over the 250k setting (/settings global compact)';
    const screen = reopened([
      { role: 'user', content: 'fix the parser' }, { role: 'assistant', content: 'Fixed.' },
      { role: 'user', content: '/compact', automatic: why }, { role: 'assistant', content: 'Compacted.' },
    ]);
    expect(screen).toContain(why);
    expect(screen).not.toContain('› /compact');
    expect(index(screen, why)).toBeLessThan(index(screen, 'Compacted.'));
    expect(reopened([{ role: 'user', content: '/compact' }, { role: 'assistant', content: 'Compacted.' }])).toContain('› /compact');
  });

  it('is drawn as its notice while it runs, from the turn\'s journal', () => {
    const why = 'Compacted before switching accounts: personal is nearly out of usage';
    const written: string[] = [];
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter();
    try {
      const base = { id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello.' }] };
      rl.render(base as never);
      // A window following the worker's turn: it was named no prompt (worker-turn.ts).
      rl.submitted(undefined);
      rl.startWaiting('compacting before the account switch', () => undefined, async () => ({ kind: 'sent' }) as never);
      rl.render({ ...base, pendingTurn: { prompt: '/compact', automatic: why, startedAt: '', updatedAt: '', outputStarted: false } } as never, undefined, { running: true });
      vi.advanceTimersByTime(400);
      const screen = strip(written.join('')).replace(/\s+/g, ' ');
      expect(screen).toContain(why);
      expect(screen).not.toContain('› /compact');
    } finally { rl.close(); }
  });
});
