/** A provider switch moves the conversation in place: one session, its whole
 * history, each answer still its producer's, and no thread of the old
 * provider's left to resume. CLIKCODE_HOME is throwaway; selecting the
 * harness (install, sign-in) is stubbed. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../../session/model.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { canonicalRecord } from '../../session/canonical.js';

const worker = vi.hoisted(() => ({ running: false }));
vi.mock('./harness.js', () => ({ aiHarnessSelect: async () => undefined }));
vi.mock('../../worker/turn-bridge.js', () => ({ workerTurn: async () => (worker.running ? { prompt: 'busy' } : undefined) }));
const { moveToProvider } = await import('./conversations.js');

const saved = process.env.CLIKCODE_HOME;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-move-'));
  process.env.CLIKCODE_HOME = root;
  worker.running = false;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = saved;
  await rm(root, { recursive: true, force: true });
});

async function onClaude(fields: Partial<HarnessSession> = {}): Promise<void> {
  const state = await readState();
  const now = new Date().toISOString();
  state.sessions.push({
    id: 's1', conversationId: 's1', route: 'local', accountId: null, provider: 'anthropic', model: 'opus', nativeHarness: 'claude',
    effort: 'medium', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
    nativeSessionId: 'claude-thread', nativeTransport: 'acp', reported: { at: now, model: 'opus' }, lastUsage: { at: now } as HarnessSession['lastUsage'],
    harnessOptions: { verbose: true },
    messages: [{ role: 'user', content: 'what is the codeword' }, { role: 'assistant', content: 'PLUM' }],
    pendingTurn: { prompt: 'and again', response: 'PL', startedAt: now, updatedAt: now, outputStarted: true },
    ...fields,
  } as HarnessSession);
  await writeState(state);
}

const stored = async (): Promise<HarnessSession[]> => (await readState()).sessions;

describe('moveToProvider', () => {
  it('changes the provider of the one session and keeps who said what', async () => {
    await onClaude();
    await moveToProvider('s1', 'codex', { model: 'gpt-5' });
    const sessions = await stored();
    expect(sessions).toHaveLength(1);
    const moved = sessions[0]!;
    expect(moved).toMatchObject({ id: 's1', route: 'local', provider: 'openai', nativeHarness: 'codex', model: 'gpt-5', permissionMode: 'ask' });
    for (const gone of ['nativeSessionId', 'nativeTransport', 'reported', 'lastUsage', 'harnessOptions', 'pendingTurn'] as const) expect(moved[gone]).toBeUndefined();
    // The interrupted turn is history now, for the next provider to continue.
    expect(moved.messages!.map((message) => message.content)).toEqual(['what is the codeword', 'PLUM', 'and again', 'PL']);
    expect(canonicalRecord(moved).turns.map((turn) => turn.origin.harness)).toEqual(['claude', 'claude']);
  });

  it('moves back the same way, with a fresh thread and the record intact', async () => {
    await onClaude({ pendingTurn: undefined });
    await moveToProvider('s1', 'codex', { model: 'gpt-5' });
    const state = await readState();
    state.sessions[0]!.messages!.push({ role: 'user', content: 'still?' }, { role: 'assistant', content: 'PLUM', origin: { harness: 'codex', route: 'local', provider: 'openai', model: 'gpt-5' } });
    state.sessions[0]!.nativeSessionId = 'codex-thread';
    await writeState(state);
    await moveToProvider('s1', 'claude', { model: 'opus' });
    const [back] = await stored();
    expect(back).toMatchObject({ id: 's1', nativeHarness: 'claude', provider: 'anthropic' });
    expect(back!.nativeSessionId).toBeUndefined();
    expect(canonicalRecord(back!).turns.map((turn) => turn.origin.harness)).toEqual(['claude', 'codex']);
  });

  it('refuses while the conversation\'s worker is running a turn', async () => {
    await onClaude();
    worker.running = true;
    await expect(moveToProvider('s1', 'codex')).rejects.toThrow(/turn is still running/);
    expect((await stored())[0]).toMatchObject({ nativeHarness: 'claude', nativeSessionId: 'claude-thread' });
  });
});
