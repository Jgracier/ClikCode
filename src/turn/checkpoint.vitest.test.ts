import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  beginPendingTurn, consumeSessionTurn, discardPendingTurn, enqueueSessionTurn, failPendingTurn, finishPendingTurn, recordPendingActivity, recordPendingSteer,
  runningActivityLabel, sessionTranscriptMessages, settledTranscriptMessages, updatePendingResponse, type PendingTurnWithHints,
} from './checkpoint.js';
import { textTranscript } from './turn-activities.js';
import { INTERRUPTED_TURN_REQUEST } from './failover-prompt.js';
import type { HarnessSession } from '../session/model.js';

/** Who answers in session(): every committed answer carries it. */
const by = { origin: { route: 'local' as const, provider: 'openai', model: null } };

const stamp = (second: number): string => `2026-01-02T00:00:${String(second).padStart(2, '0')}.000Z`;

function session(): HarnessSession {
  return {
    id: 'session', route: 'local', accountId: null, provider: 'openai', model: null,
    effort: 'medium', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', status: 'active',
    messages: [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Done' }],
  };
}

describe('durable turn checkpoints', () => {
  it('saves a failed partial turn without listing its still-open worker as generating', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clikcode-failed-turn-'));
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = home;
    try {
      const { markFailedTurn, startTurnCheckpoint } = await import('./turn-journal.js');
      const { readState } = await import('../session/state/read.js');
      const { livePendingTurns } = await import('../session/liveness.js');
      const target = { ...session(), id: randomUUID() };
      const checkpoint = await startTurnCheckpoint({ v: 1, sessions: [target], accounts: [] } as never, target, 'Continue', {});
      checkpoint.response('Partial answer');
      await checkpoint.persistNow();
      await markFailedTurn(target.id, 'Continue');
      const saved = (await readState({ transcripts: [target.id] })).sessions.find((item) => item.id === target.id)!;
      expect(saved.pendingTurn).toMatchObject({ prompt: 'Continue', response: 'Partial answer', failedAt: expect.any(String) });
      expect((await livePendingTurns([saved], () => true)).has(target.id)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME;
      else process.env.CLIKCODE_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps a failed partial turn for continuation and reopens an empty retry', () => {
    const target = session();
    beginPendingTurn(target, 'Continue', stamp(0));
    updatePendingResponse(target, 'Partial answer', 'append', stamp(1));
    expect(failPendingTurn(target, 'Continue', stamp(2))).toBe(true);
    expect(target.pendingTurn).toMatchObject({ response: 'Partial answer', failedAt: stamp(2) });
    expect(sessionTranscriptMessages(target).at(-1)?.content).toBe('Partial answer');

    const empty = session();
    beginPendingTurn(empty, 'Try again', stamp(0));
    failPendingTurn(empty, 'Try again', stamp(1));
    beginPendingTurn(empty, 'Try again', stamp(2));
    expect(empty.pendingTurn?.failedAt).toBeUndefined();
  });
  it('persists the title and cleaned answer with the completed turn', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clikcode-complete-'));
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = home;
    try {
      const { completeTurnCheckpoint, startTurnCheckpoint } = await import('./turn-journal.js');
      const target = { ...session(), id: randomUUID(), attachments: ['/tmp/example.png'], shellNotes: [] };
      const state = { v: 1, sessions: [target], accounts: [] } as never;
      const checkpoint = await startTurnCheckpoint(state, target, 'Fix the parser', {});
      const answer = await completeTurnCheckpoint(
        target, checkpoint, '<clikcode-title>Parser Repair</clikcode-title>\nFixed it.',
        { asked: true },
      );
      expect(answer).toBe('Fixed it.');
      const { readState } = await import('../session/state/read.js');
      const saved = (await readState()).sessions.find((item) => item.id === target.id);
      expect(saved?.name).toBe('Parser Repair');
      expect(saved?.messages?.at(-1)).toEqual({ role: 'assistant', content: 'Fixed it.', ...by, turnEnd: { ms: expect.any(Number) } });
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
      { role: 'assistant', content: 'Partial answer', ...by },
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
      { role: 'assistant', content: 'Partial -- and the final answer', ...by, turnEnd: { ms: 2_000 } },
    ]);
  });

  it('carries the account the turn moved to, and a sign-in it needed, onto its answer', () => {
    const target = session();
    beginPendingTurn(target, 'Continue', '2026-01-02T00:00:00.000Z');
    target.pendingTurn!.accountSwitch = { from: 'personal', to: 'work', reason: 'quota-exhausted' };
    target.pendingTurn!.signedInTo = 'Grok Build';
    finishPendingTurn(target, 'Done.', '2026-01-02T00:00:02.000Z');
    expect(target.messages?.at(-1)?.accountSwitch).toEqual({ from: 'personal', to: 'work', reason: 'quota-exhausted' });
    expect(target.messages?.at(-1)?.signedInTo).toBe('Grok Build');
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
    recordPendingActivity(target, { kind: 'tool-start', label: 'inspect repository', id: 'inspect' }, '2026-01-02T00:00:01.000Z');
    recordPendingActivity(target, { kind: 'tool-done', label: 'inspect repository', id: 'inspect' }, '2026-01-02T00:00:02.000Z');

    // The call itself is kept with the turn, one record per call -- drawn
    // where it happened when the chat is opened again. The id is what makes
    // the two frames one call.
    expect(sessionTranscriptMessages(target).at(-1)).toEqual({
      role: 'assistant', content: '',
      activities: [{ event: { kind: 'tool-done', label: 'inspect repository', id: 'inspect' }, responseOffset: 0 }], ...by,
    });
    // A text-only reader (a replay into another provider) is told of it.
    expect(textTranscript(sessionTranscriptMessages(target)).at(-1)).toEqual({ role: 'assistant', content: 'Tool calls: inspect repository.' });
  });

  it('keeps every call of a long turn with its output, placed where it happened', () => {
    const target = session();
    beginPendingTurn(target, 'Run them', stamp(0));
    updatePendingResponse(target, 'Running the parts.\n\n', 'append', stamp(1));
    for (let index = 0; index < 30; index += 1) {
      recordPendingActivity(target, { kind: 'tool-start', label: `$ part${index}`, id: `t${index}`, category: 'run' }, stamp(2));
      recordPendingActivity(target, { kind: 'tool-done', label: `$ part${index}`, id: `t${index}`, output: [`part${index} ok`] }, stamp(3));
    }
    updatePendingResponse(target, 'All pass.', 'append', stamp(4));
    finishPendingTurn(target, undefined, stamp(5));
    const answer = target.messages!.at(-1)!;
    expect(answer.content).toBe('Running the parts.\n\nAll pass.');
    expect(answer.activities).toHaveLength(30);
    expect(answer.activities![0]).toEqual({ event: { kind: 'tool-done', label: '$ part0', id: 't0', category: 'run', output: ['part0 ok'] }, responseOffset: 'Running the parts.\n\n'.length });
    expect(target.pendingTurn).toBeUndefined();
  });

  it('splits a steered turn\'s calls between the messages it became', () => {
    const target = session();
    beginPendingTurn(target, 'Work', stamp(0));
    updatePendingResponse(target, 'First part. ', 'append', stamp(1));
    recordPendingActivity(target, { kind: 'tool-done', label: '$ one', id: 'a' }, stamp(2));
    recordPendingSteer(target, 'also two', stamp(3), target.pendingTurn!.response!.length, stamp(3));
    updatePendingResponse(target, 'Second part.', 'append', stamp(4));
    recordPendingActivity(target, { kind: 'tool-done', label: '$ two', id: 'b' }, stamp(5));
    finishPendingTurn(target, undefined, stamp(6));
    expect(target.messages!.slice(-3)).toEqual([
      { role: 'assistant', content: 'First part. ', activities: [{ event: { kind: 'tool-done', label: '$ one', id: 'a' }, responseOffset: 12 }], ...by },
      { role: 'user', content: 'also two' },
      { role: 'assistant', content: 'Second part.', activities: [{ event: { kind: 'tool-done', label: '$ two', id: 'b' }, responseOffset: 12 }], ...by, turnEnd: { ms: 6_000 } },
    ]);
  });

  it('discards an unanswered checkpoint so Escape can restore the draft', () => {
    const target = session();
    beginPendingTurn(target, 'Edit me', '2026-01-02T00:00:00.000Z');
    expect(discardPendingTurn(target, 'Edit me')).toBe(true);
    expect(sessionTranscriptMessages(target)).toEqual(target.messages);
  });

  it('keeps one line when the same request is retried before it produced output', () => {
    const target = session();
    const before = target.messages?.map((message) => message.content);
    beginPendingTurn(target, 'Fix the parser', '2026-01-02T00:00:00.000Z');
    beginPendingTurn(target, 'Fix the parser', '2026-01-02T00:00:02.000Z');
    expect(target.messages?.map((message) => message.content)).toEqual(before);
    expect(target.pendingTurn?.prompt).toBe('Fix the parser');
    expect(sessionTranscriptMessages(target).map((message) => message.content)).toEqual([...(before ?? []), 'Fix the parser']);
  });

  it('commits an older failed turn before beginning the next one', () => {
    const target = session();
    beginPendingTurn(target, 'First', '2026-01-02T00:00:00.000Z');
    updatePendingResponse(target, 'Partial', 'append', '2026-01-02T00:00:01.000Z');
    beginPendingTurn(target, 'Second', '2026-01-03T00:00:00.000Z');

    expect(target.messages?.slice(-2)).toEqual([
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Partial', ...by },
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
      { role: 'assistant', content: 'Before. ', ...by },
      { role: 'user', content: 'Prioritize tests' },
      { role: 'assistant', content: 'After.', ...by },
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

  it('queues a notification once while an identical one is undelivered', () => {
    const target = session();
    const at = '2026-01-02T00:00:00.000Z';
    const notice = (id: string, text = '[ClikCode] Background work was stopped') => ({ id, text, submittedAt: at, kind: 'notification' as const });
    enqueueSessionTurn(target, notice('n1'), at);
    enqueueSessionTurn(target, notice('n2'), at);
    // The user may well type the same words twice; those are theirs.
    enqueueSessionTurn(target, { id: 'u1', text: '[ClikCode] Background work was stopped', submittedAt: at }, at);
    enqueueSessionTurn(target, notice('n3', '[background shell 2 exited] npm test'), at);
    expect(target.queuedTurns?.map((item) => item.id)).toEqual(['n1', 'u1', 'n3']);
    // Delivered, the same news is news again.
    consumeSessionTurn(target, 'n1');
    enqueueSessionTurn(target, notice('n4'), at);
    expect(target.queuedTurns?.map((item) => item.id)).toEqual(['u1', 'n3', 'n4']);
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
      const { DurableTurnCheckpoint } = await import('./turn-journal.js');
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
    // Kept for recovery, while only the agent's row is shown in chat.
    expect(target.pendingTurn?.activities?.map((item) => item.event.label)).toEqual(['Task(Fix it)', 'Edit(src/a.ts)']);
    expect(target.pendingTurn?.activities?.[0]?.event.childTools).toBe(1);
    expect((target.pendingTurn as PendingTurnWithHints).touchedFiles).toEqual(['src/a.ts']);
    expect((target.pendingTurn as PendingTurnWithHints).mutatingActivity).toBe(true);
  });
});

describe('joining a turn another window is running', () => {
  const running = (): HarnessSession => ({
    ...session(),
    pendingTurn: {
      prompt: 'continue', startedAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:10:00.000Z', outputStarted: true,
      activities: [
        { event: { kind: 'tool-done', label: 'Bash(npx vitest)', id: 'v' }, responseOffset: 0 },
        { event: { kind: 'tool-start', label: 'Bash(node scripts/verify.mjs)', id: 'w' }, responseOffset: 0 },
      ],
    },
  });
  /** A journal written before calls were kept as records. */
  const legacy = (): HarnessSession => ({
    ...running(),
    pendingTurn: { ...running().pendingTurn!, activities: ['started Bash(npx vitest)', 'completed tool', 'started Bash(node scripts/verify.mjs)'] as never },
  });

  it('draws the conversation without the followed turn, which the live view draws', () => {
    // Folded in, it read "› continue / Interrupted turn activity: …" and then
    // the same prompt again live beneath it.
    expect(settledTranscriptMessages(running(), 'continue')).toEqual(session().messages);
    expect(sessionTranscriptMessages(running()).at(-1)?.activities?.map((item) => item.event.label)).toEqual(['Bash(npx vitest)', 'Bash(node scripts/verify.mjs)']);
  });

  it('keeps an older interrupted turn that is not the one being followed', () => {
    expect(settledTranscriptMessages(running(), 'something newer')).toHaveLength(4);
  });

  it('names the call the turn is running, and nothing once it completed', () => {
    expect(runningActivityLabel(running().pendingTurn)).toBe('running Bash(node scripts/verify.mjs)');
    const done = running();
    recordPendingActivity(done, { kind: 'tool-done', label: 'tool', id: 'w' }, '2026-01-02T00:11:00.000Z');
    expect(runningActivityLabel(done.pendingTurn)).toBeUndefined();
  });

  it('reads a journal of one-line strings as calls, and never throws on one', () => {
    expect(runningActivityLabel(legacy().pendingTurn)).toBe('running Bash(node scripts/verify.mjs)');
    const messages = sessionTranscriptMessages(legacy());
    expect(messages.at(-1)?.activities?.map((item) => [item.event.kind, item.event.label])).toEqual([
      ['tool-done', 'Bash(npx vitest)'], ['tool-start', 'Bash(node scripts/verify.mjs)'],
    ]);
    const done = legacy();
    (done.pendingTurn!.activities as unknown as string[]).push('completed tool');
    expect(runningActivityLabel(done.pendingTurn)).toBeUndefined();
    // A new call recorded onto an old journal converts it.
    recordPendingActivity(done, { kind: 'tool-start', label: 'Read(a.ts)', id: 'r' }, '2026-01-02T00:12:00.000Z');
    expect(done.pendingTurn!.activities!.map((item) => item.event.label)).toEqual(['Bash(npx vitest)', 'Bash(node scripts/verify.mjs)', 'Read(a.ts)']);
    const junk = { ...session(), pendingTurn: { ...running().pendingTurn!, activities: [null, 7, { event: 'x' }, 'nonsense'] as never } };
    expect(() => sessionTranscriptMessages(junk)).not.toThrow();
    expect(runningActivityLabel(junk.pendingTurn)).toBeUndefined();
  });

  it('stores a continuation as the rest of the interrupted answer, never as a message the user typed', () => {
    const resumed = { ...session(), messages: [{ role: 'user' as const, content: 'Fix the parser' }, { role: 'assistant' as const, content: 'Half of it' }] };
    beginPendingTurn(resumed, INTERRUPTED_TURN_REQUEST, '2026-01-01T00:00:01.000Z');
    expect(sessionTranscriptMessages(resumed)).toEqual(resumed.messages);
    updatePendingResponse(resumed, 'The other half', 'append', '2026-01-01T00:00:02.000Z');
    finishPendingTurn(resumed, undefined, '2026-01-01T00:00:03.000Z');
    expect(resumed.messages).toEqual([
      { role: 'user', content: 'Fix the parser' }, { role: 'assistant', content: 'Half of it' }, { role: 'assistant', content: 'The other half', ...by, turnEnd: { ms: 2_000 } },
    ]);
  });
});
