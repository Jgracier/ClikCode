import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession, HarnessState } from './model';

// The engine that loads a model on this computer: a turn's preparation must never wait on it.
const engine = vi.hoisted(() => ({ ensureLocalModel: vi.fn(async () => { throw new Error('the model was loaded before the turn'); }) }));
vi.mock('../local-models/index', async (original) => ({ ...await original<typeof import('../local-models/index')>(), ensureLocalModel: engine.ensureLocalModel }));

const { prepareTurn } = await import('./attach');
const { writeState } = await import('./state/write');

const local: HarnessSession = {
  id: 's1', conversationId: 's1', route: 'clikcode-local', accountId: null, provider: 'clikcode-local', model: 'qwen3.8-27b', effort: 'auto',
  permissionMode: 'auto', messages: [{ role: 'user', content: 'hi' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active',
};

describe('preparing a turn on a model on this computer', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  beforeEach(() => { process.env.CLIKCODE_HOME = mkdtempSync(join(tmpdir(), 'cc-prepare-')); });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
  });

  it('does not load the model: the window would sit on that minute with Left, Esc and Ctrl+C unread', async () => {
    await writeState({ sessions: [local], accounts: [], invocations: [], providerSettings: {}, globalSettings: { effort: 'medium', permissionMode: 'ask' } } as unknown as HarnessState);
    const { active } = await prepareTurn('s1');
    expect(active?.route).toBe('clikcode-local');
    expect(engine.ensureLocalModel).not.toHaveBeenCalled();
  });
});
