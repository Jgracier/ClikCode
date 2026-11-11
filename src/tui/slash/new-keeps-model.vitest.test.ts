/** `/new` starts the same chat setup -- provider, harness, settings AND the model the chat runs -- with none of its history.
 * The slash command built its chat by hand and took the provider's default model, while every other way of starting a
 * new chat kept the current one. CLIKCODE_HOME is throwaway; no vendor CLI runs. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../../session/model.js';

vi.mock('../../runtime/lazy-bridge', async (importOriginal) => {
  const router = await import('@clikcode/router/ai-local-harness') as Record<string, unknown>;
  const original = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.keys(original).map((name) => [name, router[name] ?? original[name]]));
});
const { aiSessionCommand } = await import('./handlers.js');
const { readState } = await import('../../session/state/read.js');
const { writeState } = await import('../../session/state/write.js');
const { forceStoreSession, unforceStoreSession } = await import('../../session/ephemeral.js');

describe('/new', () => {
  const saved = { ...process.env };
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cc-new-model-'));
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

  it('keeps the provider and the model the chat runs, not the provider default', async () => {
    const state = await readState();
    const now = new Date().toISOString();
    state.providerSettings.anthropic = { model: 'opus' };
    state.sessions.push({
      id: 's1', conversationId: 's1', route: 'local', accountId: null, provider: 'anthropic', model: 'sonnet', nativeHarness: 'claude',
      effort: 'high', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
      messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'answer' }],
    } as HarnessSession);
    forceStoreSession('s1');
    await writeState(state);
    const id = await aiSessionCommand('s1', '/new');
    expect(id).not.toBe('s1');
    const fresh = (await readState()).sessions.find((item) => item.id === id)!;
    expect(fresh).toMatchObject({ provider: 'anthropic', nativeHarness: 'claude', model: 'sonnet', effort: 'high' });
    expect(fresh.messages ?? []).toEqual([]);
  });
});
