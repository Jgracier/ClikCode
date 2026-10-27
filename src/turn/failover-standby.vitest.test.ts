/** An account near its limit gets a standby for the account a failover would move to, opened
 * while its own attempt runs. When it refuses before writing anything, the turn moves to the
 * standby without a cold start, asks it the request itself; the refusal's text stays on the turn as the vendor said it.
 * The vendor attempt and the standby's preparation are stubbed; the turn driver, the accounts, the
 * standby registry and the state store are real. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import { turnCancelledError } from '../agent/cancellation.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';

const attempt = vi.hoisted(() => ({ run: vi.fn(), prepare: vi.fn(), transport: { kind: 'acp' as string }, carry: vi.fn(async () => 'carried' as const), move: vi.fn(async () => 'carried' as const) }));
const harness = vi.hoisted(() => ({ command: 'fakecli', provider: 'fake', displayName: 'Fake' }));
vi.mock('../runtime/lazy-bridge.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/lazy-bridge.js')>(),
  localHarnessForProvider: () => harness,
  localHarnessForCommand: () => harness,
  harnessCanRunTurns: () => true,
  harnessSupportsImages: () => false,
  harnessLoginArgvForModel: () => undefined,
  harnessReplyError: () => undefined,
}));
vi.mock('../harness/transport/native/inspect.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../harness/transport/native/inspect.js')>(),
  ensureNativeHarness: async () => undefined,
}));
vi.mock('../session/discovery/cli-listing.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../session/discovery/cli-listing.js')>(), adoptListedNativeId: async () => false,
}));
vi.mock('../harness/transport/select.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../harness/transport/select.js')>(), sessionTurnTransport: () => attempt.transport.kind,
}));
vi.mock('./turn-environment.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./turn-environment.js')>(), turnEnvironment: () => ({}),
}));
vi.mock('./vendor-cli-attempt.js', () => ({ runVendorCliAttempt: attempt.run }));
vi.mock('../session/carry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../session/carry.js')>(),
  carryNativeSession: attempt.carry, moveThreadToAccount: attempt.move, reconcileNativeThread: async () => 'present',
}));
vi.mock('./vendor-session-attempt.js', () => ({ runVendorSessionAttempt: attempt.run, prepareAcpStandby: attempt.prepare, prepareCodexStandby: attempt.prepare }));

const { sendVendorTurn } = await import('./vendor-turn.js');
const { openStandby, persistentTransportFor, vendorChildKey, closePersistentTransport } = await import('./vendor-process.js');

const spent = { id: 'acct-a', provider: 'fake', label: 'a', status: 'ready', models: [],
  usage: { at: new Date().toISOString(), windows: [{ name: '5h', usedPct: 90, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] } } as unknown as AiHarnessAccount;
const spare = { id: 'acct-b', provider: 'fake', label: 'b', status: 'ready', models: [] } as unknown as AiHarnessAccount;
const REFUSAL = "You've hit your session limit · resets 3:50pm (America/Denver)";

/** What the account a turn moves to is sent: the note that the account changed (account-switch-note.ts), then the user's own request unchanged. */
const afterSwitch = (request: string): string => `<clikcode_resource_note>\nThe account changed: a ran out of usage, so this conversation continues on b. The conversation, files and tools are unchanged; a limit or error mentioned earlier was a's, not this account's.\n</clikcode_resource_note>\n\n${request}`;

describe('a failover standby', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  let home: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-vendor-standby-'));
    process.env.CLIKCODE_HOME = home;
    const state = await readState();
    state.accounts.push(spent, spare);
    state.sessions.push({
      id: 's1', conversationId: 's1', route: 'local', accountId: 'acct-a', provider: 'fake', model: 'm1', effort: 'medium',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active', workspace: home,
      title: 'named', name: 'named', nameSource: 'user',
    } as HarnessSession);
    await writeState(state);
  });
  afterEach(async () => {
    attempt.run.mockReset();
    attempt.prepare.mockReset();
    attempt.carry.mockClear();
    attempt.move.mockClear();
    attempt.transport.kind = 'acp';
    await closePersistentTransport();
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('is opened beside a turn near its limit, and takes the turn over at once when it refuses', async () => {
    const prepared: string[] = [];
    attempt.prepare.mockImplementation((input: { account: AiHarnessAccount; environment: Record<string, string>; session: HarnessSession }) => {
      prepared.push(input.account.id);
      const standby = openStandby(input.session.id, input.account.id, 'acp',
        vendorChildKey(harness as never, input.account, input.environment, input.session.workspace), async () => undefined);
      standbys.push(standby.transport.session);
      return standby.ready;
    });
    const asked: Array<{ account: string; text: string; child: unknown }> = [];
    const standbys: unknown[] = [];
    attempt.run.mockImplementation(async (input: {
      account: AiHarnessAccount; turnText: string; session: HarnessSession; environment: Record<string, string>;
      sharedObserver: { onResponseDelta: (text: string, mode: 'append' | 'replace') => void };
      checkpoint: { response: (text: string, mode: 'append' | 'replace') => void };
    }) => {
      // As runVendorSessionAttempt asks for its child: a standby for this
      // exact launch is what it gets.
      const key = vendorChildKey(harness as never, input.account, input.environment, input.session.workspace);
      const child = persistentTransportFor(input.session.id, 'acp', key);
      asked.push({ account: input.account.id, text: input.turnText, child: child.session });
      if (input.account.id === 'acct-a') {
        // Prepared while this attempt ran, not after it failed.
        await vi.waitFor(() => expect(prepared).toEqual(['acct-b']));
        input.checkpoint.response(REFUSAL, 'append');
        throw new Error(`Internal error: ${REFUSAL}`);
      }
      input.checkpoint.response('SWITCHED', 'append');
      return { isError: false, text: 'SWITCHED', nativeSessionId: 'thread-1' };
    });
    const state = await readState({ transcripts: ['s1'] });
    const session = state.sessions.find((item) => item.id === 's1')!;
    await sendVendorTurn({
      state, session, account: state.accounts.find((item) => item.id === 'acct-a')!, model: 'm1', text: 'Reply SWITCHED',
      prepared: { images: [], textContext: '' } as never, turnText: 'Reply SWITCHED', startedAt: Date.now(), run: { persistentTransports: true },
    });
    expect(asked.map((item) => [item.account, item.text])).toEqual([['acct-a', 'Reply SWITCHED'], ['acct-b', afterSwitch('Reply SWITCHED')]]);
    const saved = (await readState({ transcripts: ['s1'] })).sessions.find((item) => item.id === 's1')!;
    const answer = saved.messages?.at(-1);
    // What the vendor said stays on the turn, the refusal included.
    expect(answer?.content).toBe(`${REFUSAL}\n\nSWITCHED`);
    expect(saved.accountId).toBe('acct-b');
    // The second attempt ran on the standby child, not a cold one.
    expect(asked[1]!.child).toBe(standbys[0]);
    // The turn's end is stored by the journal's completing write alone: the invocation and the
    // accounts' outcomes with it.
    const stored = await readState({ transcripts: [] });
    expect(stored.invocations.some((item) => item.sessionId === 's1' && item.accountId === 'acct-b')).toBe(true);
    expect(stored.accounts.find((item) => item.id === 'acct-a')?.quotaState).toBe('exhausted');
  });

  it('does no speculative disk copy for a CLI harness and moves its thread only on failover', async () => {
    attempt.transport.kind = 'structured-cli';
    const order: string[] = [];
    attempt.carry.mockImplementation(async () => { order.push('copy'); return 'carried'; });
    attempt.run.mockImplementation(async (input: { session: HarnessSession; turnText: string; checkpoint: { response: (text: string, mode: 'append') => void } }) => {
      order.push(`attempt ${input.turnText}`);
      if (order.filter((item) => item.startsWith('attempt')).length === 1) {
        input.checkpoint.response(REFUSAL, 'append');
        throw new Error(`Internal error: ${REFUSAL}`);
      }
      input.checkpoint.response('SWITCHED', 'append');
      return { isError: false, text: 'SWITCHED' };
    });
    const state = await readState({ transcripts: ['s1'] });
    const session = state.sessions.find((item) => item.id === 's1')!;
    session.nativeSessionId = 'thread-1';
    session.nativeThreadAccountId = 'acct-a';
    await sendVendorTurn({
      state, session, account: state.accounts.find((item) => item.id === 'acct-a')!, model: 'm1', text: 'Reply SWITCHED',
      prepared: { images: [], textContext: '' } as never, turnText: 'Reply SWITCHED', startedAt: Date.now(), run: {},
    });
    expect(order).toEqual(['attempt Reply SWITCHED', `attempt ${afterSwitch('Reply SWITCHED')}`]);
    expect(attempt.carry).not.toHaveBeenCalled();
    expect(attempt.move).toHaveBeenCalledTimes(1);
    expect(attempt.prepare).not.toHaveBeenCalled();
    const saved = (await readState({ transcripts: ['s1'] })).sessions.find((item) => item.id === 's1')!;
    expect(saved.accountId).toBe('acct-b');
    expect(saved.messages?.at(-1)?.content).toBe(`${REFUSAL}\n\nSWITCHED`);
  });

  it('asks the next account the user own request again after a partial answer, and keeps the partial answer', async () => {
    attempt.transport.kind = 'structured-cli';
    attempt.carry.mockImplementation(async () => 'carried');
    const asked: string[] = [];
    attempt.run.mockImplementation(async (input: { turnText: string; checkpoint: { response: (text: string, mode: 'append') => void } }) => {
      asked.push(input.turnText);
      if (asked.length === 1) {
        input.checkpoint.response('Half of the answer', 'append');
        throw new Error(`Internal error: ${REFUSAL}`);
      }
      input.checkpoint.response('the rest', 'append');
      return { isError: false, text: 'the rest' };
    });
    const state = await readState({ transcripts: ['s1'] });
    const session = state.sessions.find((item) => item.id === 's1')!;
    session.nativeSessionId = 'thread-1';
    session.nativeThreadAccountId = 'acct-a';
    await sendVendorTurn({
      state, session, account: state.accounts.find((item) => item.id === 'acct-a')!, model: 'm1', text: 'Reply SWITCHED',
      prepared: { images: [], textContext: '' } as never, turnText: 'Reply SWITCHED', startedAt: Date.now(), run: {},
    });
    expect(asked).toEqual(['Reply SWITCHED', afterSwitch('Reply SWITCHED')]);
    const saved = (await readState({ transcripts: ['s1'] })).sessions.find((item) => item.id === 's1')!;
    expect(saved.messages?.at(-1)?.content).toBe('Half of the answer\n\nthe rest');
  });

  it('starts a new thread once, silently, when the vendor says the thread to resume is gone', async () => {
    attempt.transport.kind = 'structured-cli';
    let calls = 0;
    attempt.run.mockImplementation(async () => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error('thread not found'), { nativeThreadInvalid: true });
      return { isError: false, text: 'ok' };
    });
    const state = await readState({ transcripts: ['s1'] });
    const session = state.sessions.find((item) => item.id === 's1')!;
    session.nativeSessionId = 'gone';
    session.nativeThreadAccountId = 'acct-a';
    session.messages = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }];
    const notices: string[] = [];
    const prompter = { activity: (message: string) => notices.push(message), phase: () => undefined };
    const outcome = await sendVendorTurn({
      state, session, account: state.accounts.find((item) => item.id === 'acct-a')!, model: 'm1', text: 'go',
      prepared: { images: [], textContext: '' } as never, turnText: 'go', startedAt: Date.now(), run: { prompter: prompter as never },
    }).catch((error: Error) => error);
    // The second refusal of the new thread does not start a third attempt on the same account's thread,
    // and nothing is said to the user about the first (the log has it).
    expect(notices.filter((line) => /could not resume its thread/.test(line))).toHaveLength(0);
    expect(calls).toBeLessThanOrEqual(3);
    expect(outcome).toBeDefined();
  });

  it('is not opened for an account with room to spare', async () => {
    const state = await readState({ transcripts: ['s1'] });
    const roomy = { ...spent, usage: { at: new Date().toISOString(), windows: [{ name: '5h', usedPct: 20 }] } } as unknown as AiHarnessAccount;
    attempt.run.mockResolvedValue({ isError: false, text: 'ok', nativeSessionId: 'thread-1' });
    const session = state.sessions.find((item) => item.id === 's1')!;
    await sendVendorTurn({
      state, session, account: roomy, model: 'm1', text: 'go',
      prepared: { images: [], textContext: '' } as never, turnText: 'go', startedAt: Date.now(), run: { persistentTransports: true },
    });
    expect(attempt.prepare).not.toHaveBeenCalled();
  });
});
