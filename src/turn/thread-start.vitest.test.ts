/** The one start path: a native-thread writer where there is one that takes
 * the installed vendor build, the transfer everywhere else. */
import { describe, expect, it } from 'vitest';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import { canonicalRecord } from '../session/canonical.js';
import type { NativeThreadWriteContext, NativeThreadWriter } from '../session/discovery/stores.js';
import { fitRecord, nativeThreadBudget, startConversationThread, type ThreadStartInput } from './thread-start.js';
import { failoverPromptRequest } from './failover-prompt.js';

const harness = { command: 'fake', provider: 'fake', displayName: 'Fake' } as AiLocalHarnessDefinition;
const now = '2026-10-04T00:00:00.000Z';
const record = canonicalRecord({
  id: 's1', route: 'local', accountId: null, provider: 'anthropic', model: 'opus', nativeHarness: 'claude', effort: 'high',
createdAt: now, updatedAt: now, status: 'active', workspace: '/w',
  messages: [{ role: 'user', content: 'rename the parser' }, { role: 'assistant', content: 'Renamed it.' }],
} as HarnessSession);

function fakeWriter(behaviour: { ok?: boolean; result?: 'id' | 'none' | 'throw' } = {}) {
  const seen: NativeThreadWriteContext[] = [];
  const writer: NativeThreadWriter = {
    testedVersions: ['1.2.3'],
    versionOk: (context) => behaviour.ok ?? context.version === '1.2.3',
    write: async (_record, context) => {
      seen.push(context);
      if (behaviour.result === 'throw') throw new Error('disk full');
      return behaviour.result === 'none' ? undefined : { nativeId: 'native-1' };
    },
  };
  return { writer, seen };
}

const input = (fields: Partial<ThreadStartInput>): ThreadStartInput => ({
  record, request: 'now run the tests', interrupted: false, harness, workspace: '/w',
  environment: { HOME: '/profiles/fake-2' }, model: 'm1', version: async () => '1.2.3', ...fields,
});

describe('startConversationThread', () => {
  it('writes the native thread and sends only the request when a writer takes this build', async () => {
    const { writer, seen } = fakeWriter();
    const start = await startConversationThread(input({ writer }));
    expect(start).toEqual({ kind: 'native', written: { nativeId: 'native-1' }, prompt: 'now run the tests', omitted: 0 });
    // Written in the taking-over account's profile, for this workspace and model.
    expect(seen).toEqual([{ harness, workspace: '/w', environment: { HOME: '/profiles/fake-2' }, model: 'm1', version: '1.2.3' }]);
  });

  it('transfers when there is no writer', async () => {
    const start = await startConversationThread(input({}));
    expect(start.kind).toBe('transfer');
    expect(start.prompt).toContain('1. rename the parser');
    expect(failoverPromptRequest(start.prompt)).toBe('now run the tests');
  });

  it('transfers, without writing, when the installed build is not one the writer was verified on', async () => {
    const { writer, seen } = fakeWriter();
    const reasons: string[] = [];
    const start = await startConversationThread(input({ writer, version: async () => '2.0.0', onFallback: (reason) => reasons.push(reason) }));
    expect(start.kind).toBe('transfer');
    expect(seen).toEqual([]);
    expect(reasons[0]).toContain('2.0.0');
  });

  it('transfers when the writer declines or fails', async () => {
    for (const result of ['none', 'throw'] as const) {
      const { writer, seen } = fakeWriter({ result });
      const start = await startConversationThread(input({ writer }));
      expect(start.kind).toBe('transfer');
      expect(seen).toHaveLength(1);
    }
  });

  it('transfers, without writing, when the model runs behind a provider that keeps no history', async () => {
    // Goose on claude-code: its thread is forgotten after every turn, and a
    // written thread resumed there would reach a model that never sees it.
    const goose = {
      command: 'goose', provider: 'goose', displayName: 'Goose', modelProviderSeparator: '/',
      turn: { output: 'json-lines', statelessProviders: ['claude-code'] },
    } as AiLocalHarnessDefinition;
    const { writer, seen } = fakeWriter();
    const reasons: string[] = [];
    const start = await startConversationThread(input({ writer, harness: goose, model: 'claude-code/sonnet', onFallback: (reason) => reasons.push(reason) }));
    expect(start.kind).toBe('transfer');
    expect(start.prompt).toContain('1. rename the parser');
    expect(seen).toEqual([]);
    expect(reasons[0]).toContain('keeps no history');
    // Another provider on the same harness keeps its history: written.
    expect((await startConversationThread(input({ writer, harness: goose, model: 'anthropic/sonnet' }))).kind).toBe('native');
  });

  it('writes nothing for a conversation with no turns', async () => {
    const { writer, seen } = fakeWriter();
    const start = await startConversationThread(input({ writer, record: { ...record, turns: [] } }));
    expect(start.kind).toBe('transfer');
    expect(seen).toEqual([]);
  });

  it('sizes the transfer to the receiving model and to argv', async () => {
    const wide = await startConversationThread(input({ contextWindow: 1_000_000 }));
    const argv = await startConversationThread(input({ contextWindow: 1_000_000, argvLimit: 96 * 1024 }));
    expect(wide.kind === 'transfer' && wide.budget).toBe(200 * 1024);
    expect(argv.kind === 'transfer' && argv.budget).toBe(92 * 1024);
  });
});

// A whole conversation written regardless overflowed the model (365K tokens
// into a 262K window) or a free plan's whole day (Grok, 603K of 500K).
describe('a native thread sized to the model', () => {
  const long = canonicalRecord({
    id: 's2', route: 'local', accountId: null, provider: 'anthropic', model: 'opus', nativeHarness: 'claude', effort: 'high',
createdAt: now, updatedAt: now, status: 'active', workspace: '/w',
    messages: Array.from({ length: 20 }, (_, index) => [
      { role: 'user' as const, content: `request ${index}` }, { role: 'assistant' as const, content: 'x'.repeat(1000) },
    ]).flat(),
  } as HarnessSession);

  it('takes half the window, or a default when none is known', () => {
    expect(nativeThreadBudget(100_000)).toBe(200_000);
    expect(nativeThreadBudget()).toBe(400 * 1024);
  });

  it('keeps the newest turns that fit, and says how to read the rest', () => {
    const fitted = fitRecord(long, 5_000);
    expect(fitted.omitted).toBeGreaterThan(0);
    expect(fitted.omitted + fitted.record.turns.length).toBe(20);
    expect(fitted.record.turns.at(-1)!.user).toBe('request 19');
    expect(fitted.record.turns[0]!.user).toMatch(new RegExp(`^\\[ClikCode: the ${fitted.omitted} earlier turns are left out.*read_conversation\\("${long.conversationId}"\\)`));
  });

  it('writes the whole record when it fits, and the newest turn even when it alone does not', () => {
    expect(fitRecord(long, 10_000_000)).toEqual({ record: long, omitted: 0 });
    expect(fitRecord(long, 1).record.turns).toHaveLength(1);
  });

  it('writes the fitted record into the vendor thread', async () => {
    const written: number[] = [];
    const writer: NativeThreadWriter = { testedVersions: ['1.2.3'], versionOk: () => true, write: async (fitted) => { written.push(fitted.turns.length); return { nativeId: 'n' }; } };
    const start = await startConversationThread(input({ record: long, writer, contextWindow: 1_000 }));
    expect(start).toMatchObject({ kind: 'native', omitted: 20 - written[0]! });
    expect(written[0]).toBeLessThan(20);
  });
});
