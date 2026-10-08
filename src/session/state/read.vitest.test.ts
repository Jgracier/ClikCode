import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from './read.js';
import { writeState } from './write.js';

const previousHome = process.env.CLIKCODE_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
});

/** Stores an index as an older build left it: what readState normalizes. */
async function storedIndex(root: string, index: { accounts?: unknown[]; sessions?: unknown[] }): Promise<void> {
  await writeFile(join(root, 'index.json'), `${JSON.stringify({
    version: 2, installationId: 'install', devicePublicKey: { kty: 'OKP' },
    accounts: [], sessions: [], invocations: [], invocationRollups: {},
    globalSettings: { effort: 'medium', permissionMode: 'ask' }, providerSettings: {},
    ...index,
  }, null, 2)}\n`);
}

describe('harness state normalization', () => {
  it('keeps a Gateway session\'s approval setting, which its local agent honours', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-state-'));
    process.env.CLIKCODE_HOME = root;
    const now = new Date().toISOString();
    await storedIndex(root, {
      sessions: [
        { id: 'gateway', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass', createdAt: now, updatedAt: now, status: 'active' },
        { id: 'local', route: 'local', accountId: null, provider: null, model: null, effort: 'medium', permissionMode: 'workspace-write', createdAt: now, updatedAt: now, status: 'active' },
      ],
    });
    try {
      const state = await readState();
      expect(state.sessions.find((session) => session.id === 'gateway')?.permissionMode).toBe('bypass');
      expect(state.sessions.find((session) => session.id === 'local')?.permissionMode).toBe('ask');
      expect(state.sessions.find((session) => session.id === 'gateway')?.conversationId).toBe('gateway');
      expect(state.sessions.find((session) => session.id === 'local')?.conversationId).toBe('local');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks a thread from before ACP with the CLI that made it, once, and nothing else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-state-'));
    process.env.CLIKCODE_HOME = root;
    const now = new Date().toISOString();
    const session = (id: string, fields: object) => ({
      id, route: 'local', accountId: null, provider: 'x', model: null, effort: 'medium', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active', ...fields,
    });
    await storedIndex(root, {
      sessions: [
        session('old-gemini', { nativeHarness: 'gemini', nativeSessionId: 'cli-thread' }),
        session('acp-gemini', { nativeHarness: 'gemini', nativeSessionId: 'acp-thread', nativeTransport: 'acp' }),
        session('minted', { nativeHarness: 'qwen', nativeSessionId: 'minted', nativeSessionPreallocated: true }),
        session('fresh', { nativeHarness: 'cursor' }),
        session('droid', { nativeHarness: 'droid', nativeSessionId: 'droid-thread' }),
      ],
    });
    try {
      const transports = async () => Object.fromEntries((await readState()).sessions.map((item) => [item.id, item.nativeTransport]));
      const expected = { 'old-gemini': 'structured-cli', 'acp-gemini': 'acp', minted: undefined, fresh: undefined, droid: undefined };
      expect(await transports()).toEqual(expected);
      expect(await transports()).toEqual(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('drops a saved account failover and a per-session context profile so the next write removes them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-state-'));
    process.env.CLIKCODE_HOME = root;
    const now = new Date().toISOString();
    await storedIndex(root, {
      sessions: [{
        id: 'old', route: 'local', accountId: null, provider: 'openai', model: null, effort: 'medium', permissionMode: 'ask',
        accountFailover: 'never', contextProfile: 'full', createdAt: now, updatedAt: now, status: 'active',
      }],
      globalSettings: { effort: 'medium', permissionMode: 'ask', accountFailover: 'never' },
      providerSettings: { openai: { effort: 'high', accountFailover: 'on-quota-exhausted' } },
    } as { sessions: unknown[] });
    try {
      const state = await readState();
      const session = state.sessions.find((item) => item.id === 'old') as Record<string, unknown>;
      expect(session.accountFailover).toBeUndefined();
      expect(session.contextProfile).toBeUndefined();
      expect(session.permissionMode).toBe('ask');
      expect((state.globalSettings as Record<string, unknown>).accountFailover).toBeUndefined();
      expect((state.providerSettings.openai as Record<string, unknown>).accountFailover).toBeUndefined();
      expect(state.providerSettings.openai?.effort).toBe('high');
      const saved = JSON.parse(await readFile(join(root, 'index.json'), 'utf8')) as { sessions: Array<Record<string, unknown>>; globalSettings: Record<string, unknown>; providerSettings: Record<string, Record<string, unknown>> };
      expect(saved.sessions[0]?.accountFailover).toBeUndefined();
      expect(saved.sessions[0]?.contextProfile).toBeUndefined();
      expect(saved.globalSettings.accountFailover).toBeUndefined();
      expect(saved.providerSettings.openai?.accountFailover).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('drops a usage estimate an older build stored and its high-water limit, and keeps the vendor\'s own reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-state-'));
    process.env.CLIKCODE_HOME = root;
    const now = new Date().toISOString();
    const base = { provider: 'openai', authKind: 'vendor-cli', models: [], status: 'ready' };
    await storedIndex(root, {
      accounts: [
        { ...base, id: 'estimated', label: 'estimated', credentialRef: 'native:e', usageLearning: { highWater: { weekly: 1 }, hits: [] },
          usage: { at: now, label: 'Weekly 0% left', learned: true, windows: [{ name: 'weekly', usedPct: 100 }] } },
        { ...base, id: 'vendor', label: 'vendor', credentialRef: 'native:v',
          usage: { at: now, label: '5h 99% left', windows: [{ name: '5h', usedPct: 1 }] } },
      ],
    });
    try {
      const state = await readState();
      const estimated = state.accounts.find((account) => account.id === 'estimated') as Record<string, unknown> | undefined;
      // Its refusals stay; the faulty high-water "limit" does not.
      expect(estimated?.usageLearning).toEqual({ turns: [], hits: [] });
      expect(estimated?.usage).toBeUndefined();
      expect(state.accounts.find((account) => account.id === 'vendor')?.usage?.label).toBe('5h 99% left');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps learning two processes recorded on one account, whichever writes last', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-state-'));
    process.env.CLIKCODE_HOME = root;
    const now = Date.now();
    await storedIndex(root, {
      accounts: [{ id: 'a', provider: 'antigravity', label: 'a', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:a',
        usageLearning: { turns: [[now - 60_000, 100]], hits: [] } }],
    });
    try {
      // Two windows read the same account, each records something, each saves.
      const first = await readState();
      const second = await readState();
      const at = new Date(now).toISOString();
      first.accounts[0]!.usageLearning = { ...first.accounts[0]!.usageLearning!, hits: [{ at, costs: { '5h': 100 } }] };
      second.accounts[0]!.usageLearning = { ...second.accounts[0]!.usageLearning!, turns: [...second.accounts[0]!.usageLearning!.turns, [now - 30_000, 100]] };
      await writeState(first);
      await writeState(second);
      const learning = (await readState()).accounts[0]!.usageLearning!;
      expect(learning.hits.map((hit) => hit.at)).toEqual([at]);
      expect(learning.turns).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
