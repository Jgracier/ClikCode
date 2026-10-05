/** Two windows following one turn that ran out both offer "Resume in". The
 * conversation moves once; the other window follows it and sends nothing.
 * CLIKCODE_HOME is throwaway; the move is stubbed so no vendor runs. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiLocalHarnessDefinition } from '../../harness/definition';
import type { HarnessSession } from '../../session/model';
import { readState } from '../../session/state/read';
import { writeState } from '../../session/state/write';
import { forceStoreSession, unforceStoreSession } from '../../session/ephemeral';
import { leaveProvider } from '../../session/native-thread';
import { INTERRUPTED_TURN_REQUEST } from '../../turn/failover-prompt';

const moves = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../commands/ai/conversations', async (original) => ({
  ...await original<typeof import('../../commands/ai/conversations')>(),
  moveToProvider: async (id: string, command: string) => {
    moves.count += 1;
    // Slow enough that an unlocked second caller would read before this write.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const state = await readState({ transcripts: [id] });
    const session = state.sessions.find((item) => item.id === id)!;
    leaveProvider(session);
    session.nativeHarness = command;
    await writeState(state);
  },
}));
const { resumeIn } = await import('./resume-in');

const saved = process.env.CLIKCODE_HOME;
let root: string;
const codex = { command: 'codex', provider: 'openai', displayName: 'Codex' } as AiLocalHarnessDefinition;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-resume-join-'));
  process.env.CLIKCODE_HOME = root;
  moves.count = 0;
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
  it('moves the conversation once: the first window sends the continuation, the second follows without sending', async () => {
    await interrupted('2026-10-03T10:00:00.000Z');
    const [first, second] = await Promise.all([
      resumeIn('s1', codex, 'acct', null, 'fix the parser', 'fix the parser', 'claude'),
      resumeIn('s1', codex, 'acct', null, 'fix the parser', 'fix the parser', 'claude'),
    ]);
    expect(moves.count).toBe(1);
    expect([first.id, second.id]).toEqual(['s1', 's1']);
    expect([first.prompt, second.prompt].sort()).toEqual([INTERRUPTED_TURN_REQUEST, undefined].sort());
    const moved = (await readState({ transcripts: ['s1'] })).sessions.find((item) => item.id === 's1')!;
    expect(moved.nativeHarness).toBe('codex');
    // The interrupted turn is history now, its answer still Claude's.
    expect(moved.pendingTurn).toBeUndefined();
    expect(moved.messages).toEqual([expect.objectContaining({ role: 'user', content: 'fix the parser' }), expect.objectContaining({ content: 'half', origin: expect.objectContaining({ harness: 'claude' }) })]);
  });

  it('moves it again when a later turn runs out there', async () => {
    await interrupted('2026-10-03T10:00:00.000Z');
    await resumeIn('s1', codex, 'acct', null, 'fix the parser', 'fix the parser', 'claude');
    const later = await resumeIn('s1', { ...codex, command: 'kilo' }, 'acct', null, 'go on', 'go on', 'codex');
    expect(moves.count).toBe(2);
    expect(later).toEqual({ id: 's1', prompt: 'go on' });
  });
});
