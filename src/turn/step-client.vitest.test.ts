import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../session/model';

const mocks = vi.hoisted(() => ({ impl: { current: (async (_session: unknown): Promise<unknown> => undefined) }, calls: [] as unknown[], reads: 0 }));
vi.mock('../agent/models/for-session.js', () => ({ modelClientForSession: (session: unknown) => { mocks.calls.push(session); return mocks.impl.current(session); } }));
// Reading the state file during a turn is what this replaced: a read fails the test.
vi.mock('../session/state/read.js', () => ({ readState: async () => { mocks.reads += 1; throw new Error('the turn must not read the state file'); } }));
vi.mock('../session/state/index-file.js', () => ({ loadIndex: async () => { mocks.reads += 1; throw new Error('the turn must not read the index'); } }));

import { stepClientRefresher } from './agent-turn';
import { LiveSettings } from './live-settings';

const base = { id: 's1', route: 'gateway', model: null, effort: 'auto', speed: undefined } as unknown as HarnessSession;

describe('stepClientRefresher', () => {
  beforeEach(() => { mocks.calls.length = 0; mocks.reads = 0; });
  const liveOf = (session: HarnessSession) => new LiveSettings(session);

  it('rebuilds from the agent model when the chat chose none', async () => {
    const session = { ...base } as HarnessSession;
    const live = liveOf(session);
    live.apply({ effort: 'high' });
    mocks.impl.current = async () => 'next';
    const adopt = vi.fn();
    const refresh = stepClientRefresher({ live, session, config: {} as never, agentModel: 'agent-model', current: () => 'old' as never, adopt, notice: vi.fn() });
    await expect(refresh()).resolves.toBe('next');
    expect(mocks.calls[0]).toMatchObject({ model: 'agent-model', effort: 'high' });
    expect(adopt).toHaveBeenCalledWith('next');
  });

  it('keeps the previous client and says so when the rebuild fails', async () => {
    const session = { ...base } as HarnessSession;
    const live = liveOf(session);
    live.apply({ model: 'broken' });
    mocks.impl.current = async () => { throw new Error('no such model'); };
    const notice = vi.fn();
    const refresh = stepClientRefresher({ live, session, config: {} as never, agentModel: undefined, current: () => 'old' as never, adopt: vi.fn(), notice });
    const out = await refresh(); expect(out).toBe('old');
    expect(String(notice.mock.calls[0]?.[0])).toContain('no such model');
  });

  it('sees a change made between two steps, with no state read', async () => {
    const session = { ...base } as HarnessSession;
    const live = liveOf(session);
    mocks.impl.current = async () => 'next';
    const refresh = stepClientRefresher({ live, session, config: {} as never, agentModel: undefined, current: () => 'old' as never, adopt: vi.fn(), notice: vi.fn() });
    await expect(refresh()).resolves.toBeUndefined();
    live.apply({ effort: 'high', speed: 'fast' });
    await expect(refresh()).resolves.toBe('next');
    expect(mocks.calls[0]).toMatchObject({ effort: 'high', speed: 'fast' });
    live.apply({ route: 'local' } as never);
    await expect(refresh()).resolves.toBe('switch');
    expect(mocks.reads).toBe(0);
  });

  it('a permission change is seen by the next tool call from the live settings', async () => {
    const live = liveOf({ ...base, permissionMode: 'ask' } as HarnessSession);
    const mode = async () => live.permissionMode;
    await expect(mode()).resolves.toBe('ask');
    live.apply({ permissionMode: 'bypass' });
    await expect(mode()).resolves.toBe('bypass');
    expect(mocks.reads).toBe(0);
  });
});
