import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../session/model';

const mocks = vi.hoisted(() => ({ impl: { current: (async (_session: unknown): Promise<unknown> => undefined) }, calls: [] as unknown[], stored: { current: undefined as unknown } }));
vi.mock('../agent/models/for-session.js', () => ({ modelClientForSession: (session: unknown) => { mocks.calls.push(session); return mocks.impl.current(session); } }));
vi.mock('../session/state/read.js', () => ({ readState: async () => ({ sessions: [mocks.stored.current] }) }));

import { stepClientRefresher } from './agent-turn';

const base = { id: 's1', route: 'gateway', model: undefined, effort: 'auto', speed: undefined } as unknown as HarnessSession;

describe('stepClientRefresher', () => {
  beforeEach(() => { mocks.calls.length = 0; });

  it('rebuilds from the agent model when the chat chose none', async () => {
    const session = { ...base } as HarnessSession;
    mocks.stored.current = { ...base, effort: 'high' };
    mocks.impl.current = async () => 'next';
    const adopt = vi.fn();
    const refresh = stepClientRefresher({ session, config: {} as never, agentModel: 'agent-model', current: () => 'old' as never, adopt, notice: vi.fn() });
    await expect(refresh()).resolves.toBe('next');
    expect(mocks.calls[0]).toMatchObject({ model: 'agent-model', effort: 'high' });
    expect(adopt).toHaveBeenCalledWith('next');
  });

  it('keeps the previous client and says so when the rebuild fails', async () => {
    const session = { ...base } as HarnessSession;
    mocks.stored.current = { ...base, model: 'broken' };
    mocks.impl.current = async () => { throw new Error('no such model'); };
    const notice = vi.fn();
    const refresh = stepClientRefresher({ session, config: {} as never, agentModel: undefined, current: () => 'old' as never, adopt: vi.fn(), notice });
    const out = await refresh(); expect(out).toBe('old');
    expect(String(notice.mock.calls[0]?.[0])).toContain('no such model');
  });
});
