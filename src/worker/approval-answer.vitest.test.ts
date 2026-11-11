/** "Tell it instead": the told text is sent after the denial, by order of
 * the calls, not by which event-loop tick each lands on. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from '../tui/prompter.js';
import { answerWorkerApproval } from './approval-answer.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

describe('answerWorkerApproval', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 30 });
    process.stdout.write = (() => true) as typeof process.stdout.write;
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  function window(sent: string[]): { rl: TerminalHarnessPrompter; key: (k: string) => void } {
    const rl = new TerminalHarnessPrompter();
    rl.render({ id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
    rl.startWaiting('thinking', () => undefined, async (text: string) => { sent.push(`steer:${text}`); return { disposition: 'steered' } as never; });
    const inner = rl as unknown as { onWaitingKey(k: string): void };
    return { rl, key: (k) => inner.onWaitingKey(k) };
  }

  it('sends the denial, then the told text', async () => {
    const sent: string[] = [];
    const { rl, key } = window(sent);
    try {
      const done = answerWorkerApproval(rl, { id: 'a1', title: 'make release' }, new AbortController().signal,
        (approved) => sent.push(`approval:${String(approved)}`));
      vi.advanceTimersByTime(1000);
      key('t');
      for (const ch of 'use pnpm') key(ch);
      key('\r');
      // The prompter itself sends nothing: the text rides on the answer.
      expect(sent).toEqual([]);
      await done;
      expect(sent).toEqual(['approval:false', 'steer:use pnpm']);
    } finally { rl.close(); }
  });

  it('sends nothing for a request withdrawn before it was answered', async () => {
    const sent: string[] = [];
    const { rl } = window(sent);
    try {
      const closing = new AbortController();
      const done = answerWorkerApproval(rl, { id: 'a2', title: 'make clean' }, closing.signal, (approved) => sent.push(`approval:${String(approved)}`));
      closing.abort();
      await done;
      expect(sent).toEqual([]);
    } finally { rl.close(); }
  });
});
