/** The one start path: a native-thread writer where there is one that takes
 * the installed vendor build, the transfer everywhere else. */
import { describe, expect, it } from 'vitest';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import { canonicalRecord } from '../session/canonical.js';
import type { NativeThreadWriteContext, NativeThreadWriter } from '../session/discovery/stores.js';
import { startConversationThread, type ThreadStartInput } from './thread-start.js';
import { failoverPromptRequest } from './failover-prompt.js';

const harness = { command: 'fake', provider: 'fake', displayName: 'Fake' } as AiLocalHarnessDefinition;
const now = '2026-10-04T00:00:00.000Z';
const record = canonicalRecord({
  id: 's1', route: 'local', accountId: null, provider: 'anthropic', model: 'opus', nativeHarness: 'claude', effort: 'high',
  accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active', workspace: '/w',
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
    expect(start).toEqual({ kind: 'native', written: { nativeId: 'native-1' }, prompt: 'now run the tests' });
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
