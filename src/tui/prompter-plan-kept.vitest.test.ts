/** Standard section 7: finishing every step does not delete the plan. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

describe('the plan of a finished turn', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  function window(): { rl: TerminalHarnessPrompter; since: () => string } {
    const written: string[] = [];
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 30 });
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
      return true;
    }) as typeof process.stdout.write;
    const rl = new TerminalHarnessPrompter();
    rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
    rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
    let mark = 0;
    return { rl, since: () => { const text = strip(written.slice(mark).join('')); mark = written.length; return text; } };
  }

  // MEASURED 2026-10-11 through the harness matrix: seven harnesses drew the plan while the turn ran
  // and nothing once it ended, though the saved turn holds it and a reopened chat draws it.
  it('is kept as a row when the turn ends, the same rows a reopened chat draws', () => {
    const { rl, since } = window();
    try {
      rl.response('Before the plan.\n\n');
      rl.setPlan([{ content: 'Do mkrPlanOne', status: 'completed' }, { content: 'Then mkrPlanTwo', status: 'in_progress' }] as never);
      vi.advanceTimersByTime(300);
      rl.response('After the plan.\n\n');
      rl.setPlan([{ content: 'Do mkrPlanOne', status: 'completed' }, { content: 'Then mkrPlanTwo', status: 'completed' }] as never);
      vi.advanceTimersByTime(300);
      since();
      rl.stopWaiting(true);
      vi.advanceTimersByTime(300);
      const text = since();
      expect(text).toContain('Plan · 2/2 done');
      expect(text).toContain('mkrPlanOne');
      expect(text).toContain('mkrPlanTwo');
      // The prose that followed the plan was retired to scrollback while the plan was still a band, and
      // scrollback is append-only: the kept row lands below what was written, drawn once (a reopened chat
      // places it at its offset, turn-mark-rows.ts).
      expect(text.indexOf('Plan · 2/2 done')).toBe(text.lastIndexOf('Plan · 2/2 done'));
      expect(text.lastIndexOf('After the plan.')).toBeLessThan(text.lastIndexOf('Plan · 2/2 done'));
    } finally { rl.close(); }
  });

  it('draws nothing when the vendor removed the plan, and nothing for a turn that had none', () => {
    const { rl, since } = window();
    try {
      rl.response('An answer.\n\n');
      rl.setPlan([{ content: 'Do mkrPlanOne', status: 'in_progress' }] as never);
      vi.advanceTimersByTime(300);
      rl.setPlan([]);
      vi.advanceTimersByTime(300);
      since();
      rl.stopWaiting(true);
      vi.advanceTimersByTime(300);
      expect(since()).not.toContain('Plan ·');
    } finally { rl.close(); }
  });
});
