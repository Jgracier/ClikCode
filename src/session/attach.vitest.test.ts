import { mkdtempSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { afterTurnFailure, claimConversation, leaveConversation, openConversation, releaseConversationClaim } from './attach';
import { readState } from './state/read';
import { writeState } from './state/write';
import { acquireSessionClaim } from './claims';
import type { HarnessSession, HarnessState } from './model';

const session = (overrides: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', conversationId: 's1', route: 'local', accountId: null, provider: 'vendor', model: 'm', effort: 'high',
  permissionMode: 'auto', accountFailover: 'never', nativeHarness: 'vendor', messages: [{ role: 'user', content: 'hi' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active', ...overrides,
});
const stateWith = (...sessions: HarnessSession[]): HarnessState => ({
  sessions, accounts: [], invocations: [], providerSettings: {},
  globalSettings: { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' },
} as unknown as HarnessState);
const stored = async (id = 's1'): Promise<HarnessSession | undefined> => (await readState({ transcripts: [id] })).sessions.find((item) => item.id === id);
/** A live claim another client, on another host, holds. */
const othersClaim = async (): Promise<void> => { await acquireSessionClaim('s1', { pid: 1, host: `${hostname()}-elsewhere` }); };

describe('a client attached to a conversation', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  beforeEach(() => { process.env.CLIKCODE_HOME = mkdtempSync(join(tmpdir(), 'cc-attach-')); });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
  });

  it('never takes a claim another live client holds, and never releases it', async () => {
    await writeState(stateWith(session()));
    await othersClaim();
    await claimConversation('s1');
    await claimConversation('s1'); // the heartbeat, too
    await releaseConversationClaim('s1');
    expect((await stored())?.claim?.pid).toBe(1);
  });

  it('keeps its own claim alive, and hands it back', async () => {
    await writeState(stateWith(session()));
    await claimConversation('s1');
    const before = (await stored())!.claim!.heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await claimConversation('s1');
    expect((await stored())!.claim!.heartbeatAt > before).toBe(true);
    await releaseConversationClaim('s1');
    expect((await stored())?.claim).toBeUndefined();
  });

  it('leaving keeps a conversation with something in it', async () => {
    await writeState(stateWith(session()));
    await claimConversation('s1');
    await leaveConversation('s1');
    const left = await stored();
    expect(left).toBeDefined();
    expect(left?.claim).toBeUndefined();
  });

  it('opens a fresh chat, and does not keep blank ones left behind', async () => {
    const leftover = session({ id: 'blank', conversationId: 'blank', messages: [] });
    await writeState(stateWith(session(), leftover));
    const id = await openConversation('/work', 'new');
    const state = await readState({ transcripts: [] });
    expect(id).not.toBe('s1');
    expect(state.sessions.map((item) => item.id)).toContain('s1');
    expect(state.sessions.map((item) => item.id)).not.toContain('blank');
  });

  it('continues the latest chat, in this workspace only when asked', async () => {
    await writeState(stateWith(session({ workspace: '/elsewhere', status: 'closed' })));
    expect(await openConversation('/work', 'continue')).toBe('s1');
    expect((await stored())?.status).toBe('active');
    expect(await openConversation('/work', 'continue', undefined, { sameWorkspace: true })).not.toBe('s1');
  });

  it('resumes a chat by the start of its id, and says what it accepts when nothing matches', async () => {
    await writeState(stateWith(session({ id: 'abcdef', conversationId: 'abcdef' })));
    expect(await openConversation('/work', 'resume', 'abcd')).toBe('abcdef');
    await expect(openConversation('/work', 'resume', 'zzz')).rejects.toThrow(/no chat matches "zzz" -- use its name/);
  });

  it('releases a queued turn that failed and hands it back, but not one the user stopped', async () => {
    const queuedTurns = [{ id: 'q1', text: 'queued words', submittedAt: '2026-01-01T00:00:00.000Z' }];
    await writeState(stateWith(session({ queuedTurns })));
    const failed = await afterTurnFailure(undefined, 's1', new Error('model unavailable'), { line: 'queued words', queuedTurnId: 'q1', guard: {} });
    expect(failed).toEqual({ cancelled: false, back: ['queued words'] });
    expect((await stored())?.queuedTurns ?? []).toEqual([]);

    await writeState(stateWith(session({ queuedTurns })));
    const stopped = Object.assign(new Error('stopped'), { code: 'ERR_TURN_CANCELLED' });
    expect(await afterTurnFailure(undefined, 's1', stopped, { line: 'queued words', queuedTurnId: 'q1', guard: {} })).toEqual({ cancelled: true, back: [] });
    expect((await stored())?.queuedTurns?.map((item) => item.id)).toEqual(['q1']);
  });

  it('asks nothing about running out where there is no one to ask', async () => {
    await writeState(stateWith(session()));
    expect(await afterTurnFailure(undefined, 's1', new Error('All accounts exhausted'), { line: 'hi', guard: {} })).toEqual({ cancelled: false, back: [] });
  });
});
