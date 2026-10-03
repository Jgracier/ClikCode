/** Two windows following one turn that ran out both offer "Resume in". Only
 * one branch is made; the other window joins it and sends nothing.
 * CLIKCODE_HOME is throwaway; branch creation is stubbed so no vendor runs. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiLocalHarnessDefinition } from '../../harness/definition';
import type { HarnessSession } from '../../session/model';
import { readState } from '../../session/state/read';
import { writeState } from '../../session/state/write';
import { forceStoreSession, unforceStoreSession } from '../../session/ephemeral';
import { INTERRUPTED_TURN_REQUEST } from '../../turn/failover-prompt';

const created = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../commands/ai/conversations', async (original) => ({
  ...await original<typeof import('../../commands/ai/conversations')>(),
  newProviderConversation: async (sourceId: string, command: string, selection: { turn?: string }) => {
    created.count += 1;
    // Slow enough that an unlocked second caller would read before this write.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const state = await readState();
    const now = new Date().toISOString();
    const id = randomUUID();
    state.sessions.push({
      id, conversationId: sourceId, parentSessionId: sourceId, route: 'local', accountId: null, provider: 'openai', model: null,
      nativeHarness: command, effort: 'medium', accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active',
      handoff: { fromSessionId: sourceId, fromHarness: 'claude', at: now, ...(selection.turn ? { turn: selection.turn } : {}) },
      messages: [{ role: 'user', content: 'fix the parser' }],
    } as HarnessSession);
    forceStoreSession(id);
    await writeState(state);
    return id;
  },
}));
const { resumeInBranch } = await import('./resume-in');

const saved = process.env.CLIKCODE_HOME;
let root: string;
const codex = { command: 'codex', provider: 'openai', displayName: 'Codex' } as AiLocalHarnessDefinition;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-resume-join-'));
  process.env.CLIKCODE_HOME = root;
  created.count = 0;
});
afterEach(async () => {
  unforceStoreSession('s1');
  if (saved === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = saved;
  await rm(root, { recursive: true, force: true });
});

async function interrupted(startedAt: string): Promise<void> {
  const state = await readState();
  const now = new Date().toISOString();
  state.sessions.push({
    id: 's1', conversationId: 's1', route: 'local', accountId: null, provider: 'anthropic', model: null, nativeHarness: 'claude',
    effort: 'medium', accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active', messages: [],
    pendingTurn: { prompt: 'fix the parser', response: 'half', startedAt, updatedAt: startedAt, outputStarted: true },
  } as HarnessSession);
  forceStoreSession('s1');
  await writeState(state);
}

describe('"Resume in" from two windows at once', () => {
  it('makes one branch: the first window sends the continuation, the second joins without sending', async () => {
    await interrupted('2026-10-03T10:00:00.000Z');
    const [first, second] = await Promise.all([
      resumeInBranch('s1', codex, 'acct', null, 'fix the parser', 'fix the parser'),
      resumeInBranch('s1', codex, 'acct', null, 'fix the parser', 'fix the parser'),
    ]);
    expect(created.count).toBe(1);
    expect(second.id).toBe(first.id);
    expect([first.prompt, second.prompt].sort()).toEqual([INTERRUPTED_TURN_REQUEST, undefined].sort());
  });

  it('makes a new branch for a later turn that runs out', async () => {
    await interrupted('2026-10-03T10:00:00.000Z');
    const first = await resumeInBranch('s1', codex, 'acct', null, 'fix the parser', 'fix the parser');
    const state = await readState({ transcripts: ['s1'] });
    state.sessions.find((item) => item.id === 's1')!.pendingTurn!.startedAt = '2026-10-03T11:00:00.000Z';
    await writeState(state);
    const later = await resumeInBranch('s1', codex, 'acct', null, 'fix the parser', 'fix the parser');
    expect(later.id).not.toBe(first.id);
    expect(later.prompt).toBe(INTERRUPTED_TURN_REQUEST);
  });
});
