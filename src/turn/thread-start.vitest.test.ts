/** The one start path: a native-thread writer where there is one that takes
 * the installed vendor build, the transfer everywhere else. */
import { describe, expect, it } from 'vitest';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import { canonicalRecord } from '../session/canonical.js';
import type { NativeThreadWriteContext, NativeThreadWriter } from '../session/discovery/stores.js';
import { carriedLine, fitRecord, nativeThreadBudget, startConversationThread, type ThreadStartInput } from './thread-start.js';
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
    expect(start).toEqual({ kind: 'native', written: { nativeId: 'native-1' }, prompt: 'now run the tests', omitted: 0, summarised: 0 });
    // Written in the taking-over account's profile, for this workspace and model.
    expect(seen).toEqual([{ harness, workspace: '/w', environment: { HOME: '/profiles/fake-2' }, model: 'm1', version: '1.2.3' }]);
  });

  it('writes no provider-boundary note into the vendor thread when the conversation came from another provider', async () => {
    const written: Array<{ providerNote?: string }[]> = [];
    const writer: NativeThreadWriter = {
      testedVersions: ['1.2.3'], versionOk: () => true,
      write: async (rec) => { written.push(rec.turns); return { nativeId: 'native-1' }; },
    };
    await startConversationThread(input({ writer }));
    expect(written).toHaveLength(1);
    expect(written[0]!.some((turn) => turn.providerNote)).toBe(false);
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
    } as unknown as AiLocalHarnessDefinition;
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

  it('treats OpenClaw statelessRoute providers as keeping no history', async () => {
    const claw = {
      command: 'openclaw', provider: 'openclaw', displayName: 'OpenClaw', modelProviderSeparator: '/',
      turn: { output: 'json', statelessRoute: { path: ['meta'], values: ['claude-cli'] } },
    } as unknown as AiLocalHarnessDefinition;
    const { writer, seen } = fakeWriter();
    const start = await startConversationThread(input({ writer, harness: claw, model: 'claude-cli/claude-opus-4-7' }));
    expect(start.kind).toBe('transfer');
    expect(seen).toEqual([]);
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
    expect(wide.kind === 'transfer' && wide.budget).toBe(1024 * 1024);
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

  it('keeps the newest turns that fit, and names the file that holds the rest and what was asked in it', () => {
    const fitted = fitRecord(long, 3_000, { recordPath: '/state/records/s2.md' });
    expect(fitted.omitted).toBeGreaterThan(0);
    expect(fitted.omitted + fitted.record.turns.length).toBe(20);
    expect(fitted.record.turns.at(-1)!.user).toContain('request 19');
    const note = fitted.record.turns[0]!.user;
    expect(note).toMatch(new RegExp(`^\\[ClikCode: the ${fitted.omitted} earlier turns are left out`));
    expect(note).toContain('/state/records/s2.md');
    // The tools it used to cite are not given to a provider, so it must not cite them.
    expect(note).not.toMatch(/search_conversations|read_conversation/);
    expect(note).toContain('What was asked in them, oldest first:');
    expect(note).toContain('1. request 0');
  });

  it('holds the note inside the budget, not on top of it', () => {
    const bytes = (turns: typeof long.turns) => turns.reduce((sum, turn) => sum + Buffer.byteLength(turn.user, 'utf8') + Buffer.byteLength(JSON.stringify(turn.parts), 'utf8'), 0);
    for (const budget of [3_000, 5_000, 9_000]) {
      const fitted = fitRecord(long, budget, { recordPath: '/state/records/s2.md' });
      // The newest turn is always kept, so a budget below it can be passed by that turn alone.
      expect(bytes(fitted.record.turns), `budget ${budget}`).toBeLessThanOrEqual(budget + 1_200);
    }
  });

  it('writes the whole record when it fits, and the newest turn even when it alone does not', () => {
    expect(fitRecord(long, 10_000_000)).toEqual({ record: long, omitted: 0, summarised: 0 });
    expect(fitRecord(long, 1).record.turns).toHaveLength(1);
  });

  it("drops older turns' tool output before dropping the turns themselves", () => {
    const call = { name: 'Bash', label: '$ npm test', status: 'done' as const, files: [], output: ['x'.repeat(2_000)] };
    const heavy = { ...long, turns: long.turns.map((turn) => ({ ...turn, parts: [...turn.parts, { type: 'tool' as const, call }], tools: [call] })) };
    // Room for every turn's words (20 KB) and one turn's output, not twenty (40 KB).
    const fitted = fitRecord(heavy, 26_000);
    expect(fitted.omitted).toBe(0);
    // The newest keeps its call and output; older ones say what ran, in words.
    const newest = fitted.record.turns[19]!.parts.at(-1);
    expect(newest?.type === 'tool' ? newest.call.output : undefined).toHaveLength(1);
    expect(fitted.record.turns[0]!.tools).toEqual([]);
    // What ran is told on the user side, never as the assistant's own words.
    const older = fitted.record.turns[0]!;
    expect(older.user).toContain('the assistant ran $ npm test');
    for (const turn of fitted.record.turns) {
      for (const part of turn.parts) if (part.type === 'text') expect(part.text).not.toContain('[Did:');
    }
    expect(older.parts.at(-1)).toMatchObject({ type: 'text' });
  });

  it('writes the fitted record into the vendor thread', async () => {
    const written: number[] = [];
    const writer: NativeThreadWriter = { testedVersions: ['1.2.3'], versionOk: () => true, write: async (fitted) => { written.push(fitted.turns.length); return { nativeId: 'n' }; } };
    const start = await startConversationThread(input({ record: long, writer, contextWindow: 1_000 }));
    expect(start).toMatchObject({ kind: 'native', omitted: 20 - written[0]! });
    expect(written[0]).toBeLessThan(20);
  });

  it('keeps a compact request and outcome for every turn in a long conversation', () => {
    const many = canonicalRecord({
      id: 'long-history', route: 'local', accountId: null, provider: 'anthropic', model: 'opus', nativeHarness: 'claude', effort: 'high',
      createdAt: now, updatedAt: now, status: 'active', workspace: '/w',
      messages: Array.from({ length: 1_420 }, (_, index) => [
        { role: 'user' as const, content: `Request ${index + 1}: preserve this decision ${index}.` },
        { role: 'assistant' as const, content: `Started work on item ${index + 1}. ${'Detailed intermediate context. '.repeat(30)}Completed item ${index + 1} successfully.` },
      ]).flat(),
    } as HarnessSession);
    const fitted = fitRecord(many, 400 * 1024, { recordPath: '/state/records/long-history.md' });
    const bytes = fitted.record.turns.reduce((sum, turn) => sum
      + Buffer.byteLength(turn.user, 'utf8') + Buffer.byteLength(JSON.stringify(turn.parts), 'utf8'), 0);

    expect(fitted.omitted).toBe(0);
    expect(fitted.record.turns).toHaveLength(1_420);
    expect(fitted.summarised).toBeGreaterThan(1_000);
    expect(fitted.record.turns[0]!.user).toContain('Request 1: preserve this decision 0.');
    expect(fitted.record.turns[0]!.assistant).toContain('successfully.');
    expect(fitted.record.turns[0]!.user).toContain('/state/records/long-history.md');
    expect(fitted.record.turns.at(-1)!.user).toContain('Request 1420: preserve this decision 1419.');
    expect(bytes).toBeLessThanOrEqual(400 * 1024);
  });
});

describe("a writer's version gate", () => {
  it('trusts a release line by default, and only the proven build when exact', async () => {
    const { testedVersion } = await import('../session/discovery/vendors/thread-writer-files.js');
    expect(testedVersion(['1.74.1'])({ version: '1.74.3' })).toBe(true);
    expect(testedVersion(['1.74.1'], { exact: true })({ version: '1.74.3' })).toBe(false);
    expect(testedVersion(['1.74.1'], { exact: true })({ version: '1.74.1' })).toBe(true);
  });
});

// Whatever of the conversation does not arrive whole is said in the chat.
describe('what a person is told was carried', () => {
  const call = { name: 'Bash', label: '$ npm test', status: 'done' as const, files: [], output: ['x'.repeat(2_000)] };
  const heavy = (() => {
    const base = canonicalRecord({
      id: 's3', route: 'local', accountId: null, provider: 'anthropic', model: 'opus', nativeHarness: 'claude', effort: 'high',
      createdAt: now, updatedAt: now, status: 'active', workspace: '/w',
      messages: Array.from({ length: 20 }, (_, index) => [
        { role: 'user' as const, content: `request ${index}` }, { role: 'assistant' as const, content: 'x'.repeat(1000) },
      ]).flat(),
    } as HarnessSession);
    return { ...base, turns: base.turns.map((turn) => ({ ...turn, parts: [...turn.parts, { type: 'tool' as const, call }], tools: [call] })) };
  })();

  it('counts the turns kept as words only (summarised) and the turns left out', () => {
    const fitted = fitRecord(heavy, 26_000);
    expect(fitted.omitted).toBe(0);
    expect(fitted.summarised).toBeGreaterThan(0);
    expect(fitted.summarised).toBeLessThan(20);
    const tight = fitRecord(heavy, 100);
    expect(tight.omitted).toBeGreaterThan(0);
    expect(tight.omitted + tight.record.turns.length).toBe(20);
  });

  it('says "carried N of M turns, K summarised" when anything was left out or shortened, and nothing when all arrived whole', () => {
    const native = (omitted: number, summarised: number) => ({ kind: 'native' as const, written: { nativeId: 'n' }, prompt: 'p', omitted, summarised });
    expect(carriedLine(757, native(145, 30), 'Claude Code', '/state/records/c.md'))
      .toBe('Carried 612 of 757 turns to Claude Code, 30 summarised; the 145 earliest are left out to fit its window. The whole conversation is saved at /state/records/c.md.');
    expect(carriedLine(20, native(0, 4), 'Codex')).toBe('Carried 20 of 20 turns to Codex, 4 summarised.');
    expect(carriedLine(20, native(0, 0), 'Codex')).toBeUndefined();
    expect(carriedLine(0, native(0, 0), 'Codex')).toBeUndefined();
    // A retelling is never the whole conversation as the provider's own thread.
    expect(carriedLine(9, { kind: 'transfer', prompt: 'p', budget: 1 }, 'Grok')).toMatch(/^Carried 9 of 9 turns to Grok, 9 summarised/);
  });
});
