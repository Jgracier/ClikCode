/** `/fork @N`: a fork through user message N and its answer, its history a
 * reference into the original's, its vendor thread dropped so the kept
 * messages are replayed. CLIKCODE_HOME is throwaway; no vendor CLI runs. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession, TranscriptMessage } from '../../session/model';
import { LEGACY_INTERRUPTED_TURN_REQUEST } from '../../turn/failover-prompt';
import { forkPoint, forkPointOptions, messagesThrough } from './fork-at';

vi.mock('../../runtime/lazy-bridge', async (importOriginal) => {
  const router = await import('@clikcode/router/ai-local-harness') as Record<string, unknown>;
  const original = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.keys(original).map((name) => [name, router[name] ?? original[name]]));
});
const { aiSessionCommand } = await import('./handlers');
const { readState } = await import('../../session/state/read');
const { writeState } = await import('../../session/state/write');
const { forceStoreSession, unforceStoreSession } = await import('../../session/ephemeral');
const { readFile } = await import('node:fs/promises');
const { parseChatLog } = await import('../../session/store/chat-log');
const { sessionLogPath } = await import('../../session/store/paths');

const conversation: TranscriptMessage[] = [
  { role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'second question' }, { role: 'assistant', content: 'second answer' },
  { role: 'user', content: LEGACY_INTERRUPTED_TURN_REQUEST }, { role: 'assistant', content: 'second answer, continued' },
  { role: 'user', content: 'third question' }, { role: 'assistant', content: 'third answer' },
];

describe('fork points', () => {
  it('counts the user messages, not ClikCode continuations, and keeps each answer', () => {
    expect(forkPoint('@2')).toBe(2);
    expect(forkPoint('2')).toBeUndefined();
    expect(messagesThrough(conversation, 2).map((message) => message.content).at(-1)).toBe('second answer, continued');
    expect(messagesThrough(conversation, 3)).toHaveLength(8);
    expect(() => messagesThrough(conversation, 4)).toThrow('messages 1 to 3');
    expect(forkPointOptions(conversation).map((option) => option.value)).toEqual([3, 2, 1]);
    expect(forkPointOptions(conversation)[0]!.label).toBe('3  third question');
  });
});

describe('/fork @N', () => {
  const saved = { ...process.env };
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cc-fork-at-'));
    process.env.CLIKCODE_HOME = root;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    unforceStoreSession('s1');
    Object.assign(process.env, saved);
    if (saved.CLIKCODE_HOME === undefined) delete process.env.CLIKCODE_HOME;
    await rm(root, { recursive: true, force: true });
  });

  it('forks through message N, as its own copy of the original history, with no vendor thread', async () => {
    const state = await readState();
    const now = new Date().toISOString();
    state.sessions.push({
      id: 's1', conversationId: 's1', route: 'local', accountId: null, provider: 'anthropic', model: null, nativeHarness: 'claude',
      effort: 'medium', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
      nativeSessionId: 'vendor-thread', messages: conversation,
    } as HarnessSession);
    forceStoreSession('s1');
    await writeState(state);
    const forkId = await aiSessionCommand('s1', '/fork @1 try another way');
    expect(forkId).not.toBe('s1');
    const fork = (await readState()).sessions.find((item) => item.id === forkId)!;
    expect(fork.messages?.map((message) => message.content)).toEqual(['first question', 'first answer']);
    expect(fork.nativeSessionId).toBeUndefined();
    expect(fork.name).toBe('try another way');
    expect(fork.parentSessionId).toBe('s1');
    const original = (await readState()).sessions.find((item) => item.id === 's1')!;
    expect(original.messages).toHaveLength(8);
    // Stored as its own copy of the history it was forked with (layout adapted 2026-10-20: it was a
    // reference into the original's `<id>.json`; in the message log a fork copies, so no write of
    // one chat ever reaches another's file).
    const stored = parseChatLog(await readFile(sessionLogPath(forkId!), 'utf8'));
    expect(stored.messages.map((message) => message.content)).toEqual(['first question', 'first answer']);
  });
});
