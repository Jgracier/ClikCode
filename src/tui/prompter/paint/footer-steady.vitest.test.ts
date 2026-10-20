/** The footer is one height from before a turn to after it: a thought, a notice, the background-terminals
 * count and a plan come and go without the composer or the chat moving a row. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from '../../prompter.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '|');
const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

describe('the footer keeps its height', () => {
  let written: string[];
  let rl: TerminalHarnessPrompter;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    written = [];
    Object.assign(process.stdout, { isTTY: true, columns: 90, rows: 40 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    rl = new TerminalHarnessPrompter();
    rl.render({
      id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active',
      messages: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `line ${i}` })),
    } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    rl.close();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  const settle = (): number => { vi.advanceTimersByTime(300); return rl.chromeRows; };

  it('across a turn: start, thought, text, background terminals, a notice, a plan and the end', () => {
    const resting = settle();
    rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
    const heights = new Map<string, number>();
    heights.set('started', settle());
    rl.activityEvent({ kind: 'thinking', label: 'Reading the config to see where the retry lives' } as never);
    heights.set('thought', settle());
    expect(strip(written.join('')).slice(-3000)).toContain('Reading the config');
    rl.response('Here is the answer.\n\n');
    heights.set('text', settle());
    rl.setBackgroundWork({ terminals: 2 });
    heights.set('terminals', settle());
    rl.setBackgroundWork({ terminals: 0 });
    heights.set('terminals gone', settle());
    rl.showTransientNotice('Copied the selection to the clipboard and also said a good deal more than one row holds so that it wraps onto a second row', 4000, () => rl.repaint());
    rl.repaint();
    heights.set('notice', settle());
    expect(strip(written.join('')).slice(-4000)).toContain('Copied the selection');
    vi.advanceTimersByTime(4100);
    heights.set('notice gone', settle());
    rl.setPlan([{ content: 'one', status: 'in_progress' }, { content: 'two', status: 'pending' }, { content: 'three', status: 'pending' }] as never);
    const withPlan = settle();
    rl.setPlan([{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }] as never);
    const planShrunk = settle();
    expect(planShrunk).toBe(withPlan);
    for (const [name, height] of heights) expect(height, name).toBe(resting);
    rl.stopWaiting(true);
    expect(settle()).toBe(resting);
  });

  it('draws the thought in the blank row over the status, not in a row of its own', () => {
    rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
    const before = settle();
    const rows = (): string[] => {
      const frame = written.join('');
      return [...frame.matchAll(/\u001b\[(\d+);1H([^\u001b]*)/g)].map((m) => `${m[1]}:${m[2]}`);
    };
    written.length = 0;
    rl.activityEvent({ kind: 'thinking', label: 'Weighing two approaches' } as never);
    settle();
    const drawn = rows().filter((row) => row.includes('Weighing two approaches'));
    expect(drawn).toHaveLength(1);
    const thoughtRow = Number(drawn[0]!.split(':')[0]);
    expect(rl.chromeRows).toBe(before);
    // directly over the status row
    written.length = 0;
    rl.response('Answer begins.\n\n');
    settle();
    expect(strip(written.join(''))).not.toContain('Weighing two approaches');
    expect(thoughtRow).toBeGreaterThan(0);
  });
});
