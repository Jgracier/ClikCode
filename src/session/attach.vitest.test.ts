import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { afterTurnFailure, claimConversation, leaveConversation, openConversation, releaseConversationClaim } from './attach';
import { readState } from './state/read';
import { writeState } from './state/write';
import { liveOpenConversations } from '../worker/registry';
import type { HarnessSession, HarnessState } from './model';

const session = (overrides: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', conversationId: 's1', route: 'local', accountId: null, provider: 'vendor', model: 'm', effort: 'high',
  permissionMode: 'auto', nativeHarness: 'vendor', messages: [{ role: 'user', content: 'hi' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active', ...overrides,
});
const stateWith = (...sessions: HarnessSession[]): HarnessState => ({
  sessions, accounts: [], invocations: [], providerSettings: {},
  globalSettings: { effort: 'medium', permissionMode: 'ask' },
} as unknown as HarnessState);
const stored = async (id = 's1'): Promise<HarnessSession | undefined> => (await readState({ transcripts: [id] })).sessions.find((item) => item.id === id);
const presenceFile = (id = 's1'): string => join(process.env.CLIKCODE_HOME!, 'workers', `${createHash('sha256').update(id).digest('hex').slice(0, 20)}.open`);
/** A live presence record another client (the parent process) holds. */
const othersPresence = (): void => {
  mkdirSync(join(process.env.CLIKCODE_HOME!, 'workers'), { recursive: true });
  writeFileSync(presenceFile(), JSON.stringify({ pid: process.ppid, host: hostname(), kind: 'client', nonce: 'other', at: new Date().toISOString() }));
};

describe('a client attached to a conversation', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  beforeEach(() => { process.env.CLIKCODE_HOME = mkdtempSync(join(tmpdir(), 'cc-attach-')); });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
  });

  it('never takes presence another live client holds, and never releases it', async () => {
    await writeState(stateWith(session()));
    othersPresence();
    const before = readFileSync(presenceFile(), 'utf8');
    await claimConversation('s1');
    await claimConversation('s1');
    await releaseConversationClaim('s1');
    expect(readFileSync(presenceFile(), 'utf8')).toBe(before);
    expect((await liveOpenConversations())('s1')).toBe(true);
  });

  it('records its own presence once, and hands it back', async () => {
    await writeState(stateWith(session()));
    await claimConversation('s1');
    await claimConversation('s1'); // idempotent: no second record, no timer
    expect(JSON.parse(readFileSync(presenceFile(), 'utf8'))).toMatchObject({ pid: process.pid, kind: 'client' });
    // Its own record is not "someone else has it open".
    expect((await liveOpenConversations())('s1')).toBe(false);
    await releaseConversationClaim('s1');
    expect(existsSync(presenceFile())).toBe(false);
  });

  it('needs neither the session record nor the state lock to take presence', async () => {
    await claimConversation('not-in-the-index');
    expect(existsSync(presenceFile('not-in-the-index'))).toBe(true);
    await releaseConversationClaim('not-in-the-index');
  });

  it('leaving keeps a conversation with something in it', async () => {
    await writeState(stateWith(session()));
    await claimConversation('s1');
    await leaveConversation('s1');
    const left = await stored();
    expect(left).toBeDefined();
    expect(existsSync(presenceFile())).toBe(false);
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
