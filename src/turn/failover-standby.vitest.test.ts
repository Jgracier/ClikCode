/** An account near its limit gets a standby for the account a failover would move to, opened
 * while its own attempt runs. When it refuses before writing anything, the turn moves to the
 * standby without a cold start, asks it the request itself, and keeps none of the refusal's text.
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

const attempt = vi.hoisted(() => ({ run: vi.fn(), prepare: vi.fn() }));
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
vi.mock('../harness/provision.js', () => ({ provisionChosenHarness: async () => ({ mcpInstalled: [], mcpRemoved: [], mcpSkipped: [] }) }));
vi.mock('../search/mcp-entry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../search/mcp-entry.js')>(),
  builtClikcodeLauncher: () => undefined, conversationsForAcpSession: () => [], conversationsMcpEntry: () => undefined,
}));
vi.mock('../session/discovery/cli-listing.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../session/discovery/cli-listing.js')>(), adoptListedNativeId: async () => false,
}));
vi.mock('../harness/transport/select.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../harness/transport/select.js')>(), sessionTurnTransport: () => 'acp',
}));
vi.mock('./turn-environment.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./turn-environment.js')>(), turnEnvironment: () => ({}),
}));
vi.mock('./vendor-session-attempt.js', () => ({ runVendorSessionAttempt: attempt.run, prepareAcpStandby: attempt.prepare, prepareCodexStandby: attempt.prepare }));

const { sendVendorTurn } = await import('./vendor-turn.js');
const { openStandby, persistentTransportFor, vendorChildKey, closePersistentTransport } = await import('./vendor-process.js');

const spent = { id: 'acct-a', provider: 'fake', label: 'a', status: 'ready', models: [],
  usage: { at: new Date().toISOString(), windows: [{ name: '5h', usedPct: 90, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] } } as unknown as AiHarnessAccount;
const spare = { id: 'acct-b', provider: 'fake', label: 'b', status: 'ready', models: [] } as unknown as AiHarnessAccount;
const REFUSAL = "You've hit your session limit · resets 3:50pm (America/Denver)";

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
    expect(asked.map((item) => [item.account, item.text])).toEqual([['acct-a', 'Reply SWITCHED'], ['acct-b', 'Reply SWITCHED']]);
    const saved = (await readState({ transcripts: ['s1'] })).sessions.find((item) => item.id === 's1')!;
    const answer = saved.messages?.at(-1);
    expect(answer?.content).toBe('SWITCHED');
    expect(saved.accountId).toBe('acct-b');
    // The second attempt ran on the standby child, not a cold one.
    expect(asked[1]!.child).toBe(standbys[0]);
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
