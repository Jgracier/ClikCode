import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  beginPendingTurn, consumeSessionTurn, discardPendingTurn, enqueueSessionTurn, finishPendingTurn, recordPendingActivity, recordPendingSteer,
  sessionTranscriptMessages, updatePendingResponse,
} from './checkpoint.js';
import type { HarnessSession } from '../session/model.js';

function session(): HarnessSession {
  return {
    id: 'session', route: 'local', accountId: null, provider: 'openai', model: null,
    effort: 'medium', accountFailover: 'never', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', status: 'active',
    messages: [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Done' }],
  };
}

describe('durable turn checkpoints', () => {
  it('persists the title and cleaned answer with the completed turn', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clikcode-complete-'));
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = home;
    try {
      const { completeTurnCheckpoint, startTurnCheckpoint } = await import('./runtime.js');
      const target = { ...session(), id: randomUUID(), attachments: ['/tmp/example.png'], shellNotes: [] };
      const state = { v: 1, sessions: [target], accounts: [] } as never;
      const checkpoint = await startTurnCheckpoint(state, target, 'Fix the parser', {});
      const answer = await completeTurnCheckpoint(
        target, checkpoint, '<clikcode-title>Parser Repair</clikcode-title>\nFixed it.',
      );
      expect(answer).toBe('Fixed it.');
      const { readState } = await import('../session/state/read.js');
      const saved = (await readState()).sessions.find((item) => item.id === target.id);
      expect(saved?.name).toBe('Parser Repair');
      expect(saved?.messages?.at(-1)).toEqual({ role: 'assistant', content: 'Fixed it.' });
      expect(saved?.attachments).toEqual([]);
      expect(saved?.pendingTurn).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME;
      else process.env.CLIKCODE_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('makes a submitted prompt and streamed response portable before completion', () => {
    const target = session();
    beginPendingTurn(target, 'Continue the work', '2026-01-02T00:00:00.000Z');
    updatePendingResponse(target, 'Partial ', 'append', '2026-01-02T00:00:01.000Z');
    updatePendingResponse(target, 'answer', 'append', '2026-01-02T00:00:02.000Z');

    expect(sessionTranscriptMessages(target).slice(-2)).toEqual([
      { role: 'user', content: 'Continue the work' },
      { role: 'assistant', content: 'Partial answer' },
    ]);
    expect(target.messages).toHaveLength(2);
  });

  it('finalizes exactly once and clears the in-flight journal', () => {
    const target = session();
    beginPendingTurn(target, 'Continue', '2026-01-02T00:00:00.000Z');
    updatePendingResponse(target, 'Partial', 'append', '2026-01-02T00:00:01.000Z');
    // The report contains everything that streamed, and more.
    finishPendingTurn(target, 'Partial -- and the final answer', '2026-01-02T00:00:02.000Z');

    expect(target.pendingTurn).toBeUndefined();
    expect(target.messages?.slice(-2)).toEqual([
      { role: 'user', content: 'Continue' },
      { role: 'assistant', content: 'Partial -- and the final answer' },
    ]);
  });

  it('keeps what streamed when the report is only its last part', () => {
    // Claude-shaped CLIs put only the LAST text block in `result`. Saving it
    // is what made everything before the final tool call vanish at turn end.
    const target = session();
    beginPendingTurn(target, 'Fix it', '2026-01-02T00:00:00.000Z');
    updatePendingResponse(target, "I'm checking the workspace first.\n\nFound it: the fix is live.", 'append', '2026-01-02T00:00:01.000Z');
    finishPendingTurn(target, 'Found it: the fix is live.', '2026-01-02T00:00:02.000Z');
    expect(target.messages?.at(-1)?.content).toBe("I'm checking the workspace first.\n\nFound it: the fix is live.");
  });

  it('uses the report when nothing streamed', () => {
    const target = session();
    beginPendingTurn(target, 'Hi', '2026-01-02T00:00:00.000Z');
    finishPendingTurn(target, 'Hello.', '2026-01-02T00:00:01.000Z');
    expect(target.messages?.at(-1)?.content).toBe('Hello.');
  });

  it('clears a failed attempt before a failover response starts', () => {
    const target = session();
    beginPendingTurn(target, 'Continue', '2026-01-02T00:00:00.000Z');
    updatePendingResponse(target, 'obsolete partial', 'append', '2026-01-02T00:00:01.000Z');
    updatePendingResponse(target, '', 'replace', '2026-01-02T00:00:02.000Z');
    expect(target.pendingTurn?.response).toBeUndefined();
    expect(target.pendingTurn?.outputStarted).toBe(false);
    updatePendingResponse(target, 'replacement', 'replace', '2026-01-02T00:00:03.000Z');
    expect(target.pendingTurn?.response).toBe('replacement');
  });

  it('retains bounded tool activity when a provider fails before prose', () => {
    const target = session();
    beginPendingTurn(target, 'Fix it', '2026-01-02T00:00:00.000Z');
    recordPendingActivity(target, { kind: 'tool-start', label: 'inspect repository' }, '2026-01-02T00:00:01.000Z');
    recordPendingActivity(target, { kind: 'tool-done', label: 'inspect repository' }, '2026-01-02T00:00:02.000Z');

    expect(sessionTranscriptMessages(target).at(-1)).toEqual({
      role: 'assistant',
      content: 'Interrupted turn activity: started inspect repository; completed inspect repository. Inspect the current workspace before continuing.',
    });
  });

  it('discards an unanswered checkpoint so Escape can restore the draft', () => {
    const target = session();
    beginPendingTurn(target, 'Edit me', '2026-01-02T00:00:00.000Z');
    expect(discardPendingTurn(target, 'Edit me')).toBe(true);
    expect(sessionTranscriptMessages(target)).toEqual(target.messages);
  });

  it('commits an older failed turn before beginning the next one', () => {
    const target = session();
    beginPendingTurn(target, 'First', '2026-01-02T00:00:00.000Z');
    updatePendingResponse(target, 'Partial', 'append', '2026-01-02T00:00:01.000Z');
    beginPendingTurn(target, 'Second', '2026-01-03T00:00:00.000Z');

    expect(target.messages?.slice(-2)).toEqual([
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Partial' },
    ]);
    expect(target.pendingTurn?.prompt).toBe('Second');
  });

  it('preserves native steering inside the active turn transcript', () => {
    const target = session();
    beginPendingTurn(target, 'Initial request', '2026-01-02T00:00:00.000Z');
    updatePendingResponse(target, 'Before. After.', 'append', '2026-01-02T00:00:01.000Z');
    recordPendingSteer(target, 'Prioritize tests', '2026-01-02T00:00:01.000Z', 8, '2026-01-02T00:00:01.000Z');
    expect(sessionTranscriptMessages(target).slice(-4)).toEqual([
      { role: 'user', content: 'Initial request' },
      { role: 'assistant', content: 'Before. ' },
      { role: 'user', content: 'Prioritize tests' },
      { role: 'assistant', content: 'After.' },
    ]);
  });

  it('durably queues and atomically consumes a follow-up turn', () => {
    const target = session();
    const queued = { id: 'queued-1', text: '/this remains conversation text', submittedAt: '2026-01-02T00:00:00.000Z' };
    enqueueSessionTurn(target, queued, queued.submittedAt);
    enqueueSessionTurn(target, queued, queued.submittedAt);
    expect(target.queuedTurns).toEqual([queued]);
    expect(consumeSessionTurn(target, queued.id)).toBe(true);
    expect(target.queuedTurns).toBeUndefined();
  });
});

describe('a live submission is queued or it is not', () => {
  /** Reported: a queued message ran, and its text came back in the composer
   * at the same time. queue() writes the entry and then persists it; when the
   * write failed, the rejection handed the text back to the draft while the
   * entry a later flush carried ran the turn anyway. The composer cannot
   * represent both, so a failed write takes the entry out again. */
  it('is not left in the queue when its write fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clikcode-queue-'));
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = home;
    try {
      const { DurableTurnCheckpoint } = await import('./runtime.js');
      const session = {
        id: randomUUID(), conversationId: randomUUID(), route: 'local', status: 'active',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [],
      } as unknown as Parameters<typeof beginPendingTurn>[0];
      const state = { v: 1, sessions: [session], accounts: [] } as never;
      const checkpoint = await DurableTurnCheckpoint.start(state, session, 'first prompt');

      // Every write from here on fails, the way a full disk or a revoked
      // directory does.
      await chmod(home, 0o500);
      const submission = { id: randomUUID(), text: 'follow up', submittedAt: new Date().toISOString() };
      await expect(checkpoint.queue(submission)).rejects.toThrow();
      expect(session.queuedTurns, 'a turn nobody was told about stayed in the queue').toBeUndefined();
    } finally {
      await chmod(home, 0o700).catch(() => undefined);
      if (previous === undefined) delete process.env.CLIKCODE_HOME;
      else process.env.CLIKCODE_HOME = previous;
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('running sub-agents in the turn journal', () => {
  const at = (second: number) => `2026-01-02T00:00:${String(second).padStart(2, '0')}.000Z`;

  it('adds an agent call, follows its step, and drops it when it completes', () => {
    const target = session();
    beginPendingTurn(target, 'Work', at(0));
    recordPendingActivity(target, { kind: 'tool-start', label: 'Agent(Explore the repo)', id: 'a1' }, at(1));
    recordPendingActivity(target, { kind: 'tool-start', label: 'Read(src/index.ts)', id: 'c1', parentId: 'a1' }, at(2));
    expect(target.pendingTurn?.subagents).toEqual([
      { id: 'a1', label: 'Agent(Explore the repo)', startedAt: at(1), step: 'Read(src/index.ts)', stepAt: at(2) },
    ]);
    recordPendingActivity(target, { kind: 'tool-done', label: 'Agent(Explore the repo)', id: 'a1' }, at(3));
    expect(target.pendingTurn?.subagents).toBeUndefined();
  });

  it('counts a call the envelope marks as an agent, and never a shell command', () => {
    const target = session();
    beginPendingTurn(target, 'Work', at(0));
    recordPendingActivity(target, { kind: 'tool-start', label: 'researcher', agent: true, id: 'x' }, at(1));
    recordPendingActivity(target, { kind: 'tool-start', label: 'task build', category: 'run', id: 'y' }, at(1));
    expect(target.pendingTurn?.subagents?.map((agent) => agent.id)).toEqual(['x']);
  });

  it('still records a sub-agent edit as a change to the workspace', () => {
    const target = session();
    beginPendingTurn(target, 'Work', at(0));
    recordPendingActivity(target, { kind: 'tool-start', label: 'Task(Fix it)', id: 'a1' }, at(1));
    recordPendingActivity(target, { kind: 'tool-start', label: 'Edit(src/a.ts)', category: 'edit', id: 'e', parentId: 'a1' }, at(2));
    expect(target.pendingTurn?.activities).toContain('started Edit(src/a.ts)');
  });
});
