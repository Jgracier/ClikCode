/** A chat that just moved here is warmed before its first turn (vendor-warm.ts):
 * the conversation taken up by the vendor now, and its vendor child opened up
 * to the prompt on the key the first turn will look it up by -- so the turn
 * takes that child instead of starting another. Nothing runs a vendor here:
 * the take-up and the child are stand-ins. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { vendorChildKey } from './vendor-process.js';
import { turnEnvironment } from './turn-environment.js';

const seen = vi.hoisted(() => ({ takeUps: 0, prepared: [] as Array<{ transport: string; key: string; nativeSessionId?: string; model: string | null; effort?: string }> }));
vi.mock('./vendor-thread-takeup.js', () => ({
  takeUp: async (ctx: { session: HarnessSession; account: AiHarnessAccount; checkpoint: { persistNow(): Promise<void> } }) => {
    seen.takeUps += 1;
    ctx.session.nativeSessionId = 'written-thread';
    ctx.session.nativeThreadAccountId = ctx.account.id;
    await ctx.checkpoint.persistNow();
    return '';
  },
}));
vi.mock('./vendor-session-attempt.js', async () => {
  const process = await import('./vendor-process.js');
  return {
    prepareVendorAhead: async (input: { harness: never; account: never; session: HarnessSession; transport: string; model: string | null; effort?: string; environment: Record<string, string> }) => {
      seen.prepared.push({ transport: input.transport, key: process.vendorChildKey(input.harness, input.account, input.environment, input.session.workspace),
        ...(input.session.nativeSessionId ? { nativeSessionId: input.session.nativeSessionId } : {}), model: input.model, ...(input.effort ? { effort: input.effort } : {}) });
    },
  };
});
vi.mock('../harness/transport/native/inspect.js', async (original) => ({
  ...await original<typeof import('../harness/transport/native/inspect.js')>(),
  inspectNativeHarness: async () => ({ installed: true, version: '2.1.0 (Claude Code)' }),
}));

const now = '2026-10-21T00:00:00.000Z';
const claude = localHarnessForCommand('claude')!;
const account = (fields: Partial<AiHarnessAccount> = {}): AiHarnessAccount => ({
  id: 'acc-1', provider: 'anthropic', label: 'justin@webpro.ai', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:claude:default', ...fields,
});
const chat = (fields: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', conversationId: 'c1', route: 'local', accountId: 'acc-1', provider: 'anthropic', nativeHarness: 'claude', model: 'opus',
  effort: 'high', permissionMode: 'auto', createdAt: now, updatedAt: now, status: 'active', workspace: '/home/me',
  messages: [{ role: 'user', content: 'read the parser' }, { role: 'assistant', content: 'It reads tokens.' }],
  moveNote: 'This conversation moved from a to b.', ...fields,
});
const stateOf = (sessions: HarnessSession[], accounts: AiHarnessAccount[]): HarnessState => ({
  sessions, accounts, invocations: [], providerSettings: {}, globalSettings: { effort: 'medium', permissionMode: 'ask' },
} as unknown as HarnessState);

beforeEach(() => {
  vi.stubEnv('CLIKCODE_HOME', mkdtempSync(join(tmpdir(), 'cc-warm-')));
  seen.takeUps = 0;
  seen.prepared = [];
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('warming a chat that moved here', () => {
  it('takes the conversation up now and opens its vendor child on the key its first turn uses', async () => {
    const mine = account();
    await writeState(stateOf([chat()], [mine]));
    const { warmVendor } = await import('./vendor-warm.js');
    expect(await warmVendor('s1')).toBe(true);
    expect(seen.takeUps).toBe(1);
    // The thread the take-up wrote is saved: the first turn resumes it instead of writing it again.
    const saved = (await readState({ transcripts: ['s1'] })).sessions.find((item) => item.id === 's1')!;
    expect(saved).toMatchObject({ nativeSessionId: 'written-thread', nativeThreadAccountId: 'acc-1' });
    // Still told to the agent with that first turn.
    expect(saved.moveNote).toBe('This conversation moved from a to b.');
    expect(saved.messages).toHaveLength(2);
    // The child the turn will look up (vendor-attempt.ts prepareAttempt): same account, environment and folder.
    const key = vendorChildKey(claude, mine, turnEnvironment(claude, mine, 'auto'), '/home/me');
    expect(seen.prepared).toEqual([{ transport: expect.stringMatching(/^(acp|codex-app-server)$/), key, nativeSessionId: 'written-thread', model: 'opus', effort: 'high' }]);
  });

  it('leaves to the first turn what it cannot do yet: no account, one signed out, a moved copy, an agent route', async () => {
    const { warmVendor } = await import('./vendor-warm.js');
    for (const [sessions, accounts] of [
      [[chat({ accountId: null })], []],
      [[chat()], [account({ status: 'needs_login' })]],
      [[chat({ movedTo: { machine: 'prod', sessionId: 's1', at: now } })], [account()]],
      [[chat({ route: 'gateway', nativeHarness: undefined, provider: null })], [account()]],
    ] as Array<[HarnessSession[], AiHarnessAccount[]]>) {
      await writeState(stateOf(sessions, accounts));
      expect(await warmVendor('s1')).toBe(false);
    }
    expect(seen.takeUps).toBe(0);
    expect(seen.prepared).toEqual([]);
  });
});
