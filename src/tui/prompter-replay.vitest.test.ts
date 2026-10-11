/** Standard 11: what a turn drew live is drawn when its conversation is
 * reopened, in the same order. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';
import type { HarnessSession, TranscriptMessage } from '../session/model.js';

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
