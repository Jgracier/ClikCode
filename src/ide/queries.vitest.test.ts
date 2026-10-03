/** The editor's screens as data: conversation and account lists read the
 * state file the way the terminal's pickers do, and the bridge answers the
 * revision-2 requests without disturbing a running turn. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Conf from 'conf';

const sessionCommand = vi.fn(async (id: string) => id);
const duringTurn = vi.fn(async () => ({ disposition: 'applied' }));
vi.mock('../tui/slash/handlers.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../tui/slash/handlers.js')>(),
  aiSessionCommand: sessionCommand,
}));
vi.mock('../tui/slash/queue.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../tui/slash/queue.js')>(),
  commandDuringTurn: duringTurn,
}));

const CODEX = {
  command: 'codex', displayName: 'Codex', provider: 'openai', binary: 'codex', localAuth: ['vendor-cli'], loginArgv: ['login'],
  profileEnv: 'CODEX_HOME',
};
vi.mock('../runtime/lazy-bridge.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/lazy-bridge.js')>(),
  localHarnessForProvider: (provider: string) => (provider === 'openai' ? CODEX : undefined),
  localHarnessForCommand: (command: string) => (command === 'codex' ? CODEX : undefined),
  allLocalHarnesses: () => [CODEX],
  harnessCanRunTurns: () => true,
  harnessTierRank: () => 0,
}));

const { accountList, conversationList, creditOf } = await import('./queries.js');
const { readState } = await import('../session/state/read.js');
const { IdeBridge } = await import('./bridge.js');
const { IDE_PROTOCOL } = await import('./protocol.js');
const { ensureWorkersDirectory, writeWorkerRecord } = await import('../worker/registry.js');

const previousHome = process.env.CLIKCODE_HOME;
afterEach(() => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  sessionCommand.mockClear();
  duringTurn.mockClear();
});

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id, route: 'local', accountId: null, provider: 'openai', model: null, effort: 'medium', accountFailover: 'on-quota-exhausted',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', status: 'closed', nativeHarness: 'codex', ...extra,
});

async function home(state: { sessions?: unknown[]; accounts?: unknown[] }): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'clikcode-ide-queries-'));
  process.env.CLIKCODE_HOME = root;
  await writeFile(join(root, 'harness-state.json'), `${JSON.stringify({
    version: 1, installationId: 'install', localApiToken: 'token', devicePrivateKeyPem: 'private', devicePublicKey: { kty: 'OKP' },
    accounts: state.accounts ?? [], sessions: state.sessions ?? [], invocations: [],
    globalSettings: { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' }, providerSettings: {},
  })}\n`);
}

describe('the conversation list', () => {
  it('lists each conversation once, as its latest chat, newest first, and leaves out empty and archived ones', async () => {
    await home({
      sessions: [
        session('old', { conversationId: 'root-a', updatedAt: '2026-09-02T00:00:00.000Z', messages: [{ role: 'user', content: 'fix the   login bug' }] }),
        session('handoff', { conversationId: 'root-a', parentSessionId: 'old', updatedAt: '2026-09-05T00:00:00.000Z', name: 'Login bug', messages: [{ role: 'user', content: 'fix it' }, { role: 'assistant', content: 'Done.' }] }),
        session('other', { conversationId: 'root-b', updatedAt: '2026-09-04T00:00:00.000Z', messages: [{ role: 'user', content: 'write tests for the parser' }] }),
        session('empty', { conversationId: 'root-c', updatedAt: '2026-09-06T00:00:00.000Z' }),
        session('archived', { conversationId: 'root-d', status: 'archived', updatedAt: '2026-09-07T00:00:00.000Z', messages: [{ role: 'user', content: 'x' }] }),
      ],
    });
    const rows = await conversationList(await readState(), 'other');
    // Both are older than 24 hours, so Past by recency: handoff (Sep 5) then other (Sep 4).
    expect(rows.map((row) => row.id)).toEqual(['handoff', 'other']);
    expect(rows[0]).toMatchObject({ title: 'Login bug', messages: 2, preview: 'Done.', current: false });
    expect(rows[1]).toMatchObject({ current: true, activity: 'idle', title: 'write tests for the parser', provider: 'Codex' });
  });

  it('puts generating first, then Active (24h), then Past', async () => {
    const now = Date.now();
    await home({
      sessions: [
        session('past', {
          conversationId: 'p', status: 'active',
          updatedAt: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
          messages: [{ role: 'user', content: 'old' }],
        }),
        session('active', {
          conversationId: 'a', status: 'active',
          updatedAt: new Date(now - 60 * 60 * 1000).toISOString(),
          messages: [{ role: 'user', content: 'recent' }],
        }),
      ],
    });
    const rows = await conversationList(await readState(), undefined);
    expect(rows.map((row) => row.id)).toEqual(['active', 'past']);
  });

  it('marks generating only from the transcript turn of a chat with a live worker', async () => {
    const now = new Date().toISOString();
    const turn = { prompt: 'go', startedAt: now, updatedAt: now, outputStarted: true };
    const text = { messages: [{ role: 'user', content: 'go' }] };
    await home({
      sessions: [
        session('running', { conversationId: 'r', status: 'active', updatedAt: now, ...text, pendingTurn: turn }),
        session('crashed', { conversationId: 'c', status: 'active', updatedAt: now, ...text, pendingTurn: turn }),
        // An older build's index copy of a finished turn: ignored, not scrubbed.
        session('stale', { conversationId: 's', status: 'active', updatedAt: now, ...text, listTurn: { startedAt: now, prompt: 'go' } }),
      ],
    });
    await ensureWorkersDirectory();
    for (const id of ['running', 'stale']) {
      await writeWorkerRecord({ sessionId: id, pid: process.pid, socketPath: join(process.env.CLIKCODE_HOME!, `${id}.sock`), token: 't', installationId: 'install', build: 'test', startedAt: now });
    }
    const rows = await conversationList(await readState({ transcripts: [] }), undefined);
    const by = new Map(rows.map((row) => [row.id, row.activity]));
    expect(by.get('running')).toBe('working');
    expect(by.get('stale')).toBe('idle');
    expect(by.get('crashed')).toBeUndefined();
    expect(rows[0]?.id).toBe('running');
  });
});

describe('the account list', () => {
  it('shows usage the account last published while it still holds, and what is wrong with an account', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await home({
      accounts: [
        { id: 'work', provider: 'openai', label: 'work@example.com', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:codex',
          usage: { at: new Date().toISOString(), label: '5h 40% left', windows: [{ name: '5h', usedPct: 60, resetsAt: future }] } },
        { id: 'home', provider: 'openai', label: 'home@example.com', authKind: 'vendor-cli', models: [], status: 'needs_login', credentialRef: 'native:codex' },
      ],
      sessions: [session('s1', { accountId: 'work', status: 'active' })],
    });
    const state = await readState();
    const list = await accountList(state, state.sessions[0], false);
    const work = list.accounts.find((account) => account.id === 'work')!;
    expect(work).toMatchObject({ current: true, providerName: 'Codex', usage: { label: '5h 40% left', windows: [{ name: '5h', usedPct: 60 }] } });
    expect(list.accounts.find((account) => account.id === 'home')).toMatchObject({ problem: 'reauth', current: false });
    expect(list.accounts.find((account) => account.id === 'home')!.actions).toContain('reauthenticate');
    expect(list.failover).toBe('auto');
    expect(list.addable.some((item) => item.provider === 'codex')).toBe(true);
  });
});

describe('the Gateway credit', () => {
  it('reads the balance in whichever unit the Gateway states it', () => {
    expect(creditOf({ unlimited: true })).toEqual({ unlimited: true });
    expect(creditOf({ unlimited: false, allowed: true, balanceMicroUsd: '12500000' })).toEqual({ unlimited: false, allowed: true, balanceUsd: 12.5 });
    expect(creditOf({ balanceCents: 250, autoTopUpEnabled: true })).toEqual({ unlimited: false, balanceUsd: 2.5, autoTopUp: true });
  });
});

describe('the bridge\'s revision-2 requests', () => {
  const bridgeFor = () => {
    const sent: Array<Record<string, unknown>> = [];
    const bridge = new IdeBridge({} as Conf, { send: (message) => { sent.push(message as unknown as Record<string, unknown>); } });
    const inner = bridge as unknown as { sessionId?: string; workerTurnRunning: boolean; emitSession(): Promise<void>; work: Promise<void> };
    inner.emitSession = async () => undefined;
    const result = async (requestId: string) => {
      for (let i = 0; i < 50 && !sent.some((item) => item.requestId === requestId); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      return sent.find((item) => item.requestId === requestId);
    };
    return { bridge, inner, sent, result };
  };

  it('announces its revision, and refuses a query it does not know rather than answering another', async () => {
    const { bridge, sent, result } = bridgeFor();
    bridge.start();
    for (const timer of (bridge as unknown as { timers: NodeJS.Timeout[] }).timers) clearInterval(timer);
    expect(sent[0]).toMatchObject({ type: 'ready', revision: IDE_PROTOCOL.revision });
    bridge.handle({ type: 'query', requestId: 'q', query: 'nonsense' as never });
    expect(await result('q')).toMatchObject({ ok: false, error: 'unknown query "nonsense"' });
  });

  it('applies a setting with the command the picker ends in, and mid-turn as a typed one would be', async () => {
    const { bridge, inner, result } = bridgeFor();
    inner.sessionId = 's1';
    bridge.handle({ type: 'choose', requestId: 'a', choice: { kind: 'effort', value: 'high' } });
    expect(await result('a')).toMatchObject({ ok: true });
    expect(sessionCommand).toHaveBeenCalledWith('s1', '/effort high');
    inner.workerTurnRunning = true;
    bridge.handle({ type: 'choose', requestId: 'b', choice: { kind: 'permissions', value: 'auto' } });
    expect(await result('b')).toMatchObject({ ok: true });
    expect(duringTurn).toHaveBeenCalledWith('s1', '/permissions auto');
    expect(bridge.quietOutput).toBe(0);
  });

  it('will not move a conversation to another provider under a running turn', async () => {
    const { bridge, inner, result } = bridgeFor();
    inner.sessionId = 's1';
    inner.workerTurnRunning = true;
    bridge.handle({ type: 'choose', requestId: 'p', choice: { kind: 'provider', provider: 'codex' } });
    expect(await result('p')).toMatchObject({ ok: false });
  });
});
