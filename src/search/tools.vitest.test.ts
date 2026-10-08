import { beforeEach, describe, expect, it } from 'vitest';
import type { HarnessSession, TranscriptMessage } from '../session/model.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { resetHarnessStateCaches } from '../session/state/index-file.js';
import { rm } from 'node:fs/promises';
import { appendTurnChanges } from '../session/turn-changes.js';
import { stateDirectory } from '../session/store/paths.js';
import { workersDirectory, writeWorkerRecord } from '../worker/registry.js';
import { resetCorpusCache } from './corpus.js';
import { conversationTool } from './tools.js';

const NOW = Date.now();
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

function chat(id: string, messages: TranscriptMessage[], extra: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id, route: 'local', accountId: null, provider: 'openai', model: 'gpt-5', effort: 'medium', permissionMode: 'ask',
createdAt: minutesAgo(600), updatedAt: minutesAgo(30), status: 'active', nativeHarness: 'codex',
    messages, ...extra,
  } as HarnessSession;
}

async function store(...sessions: HarnessSession[]): Promise<void> {
  const state = await readState();
  state.sessions.push(...sessions);
  await writeState(state);
}

const run = async (name: string, args: Record<string, unknown>, currentSessionId?: string) =>
  conversationTool(name)!.run(args, { ...(currentSessionId ? { currentSessionId } : {}), now: NOW });

const OTHER = 'aaaaaaaa-1111-4111-8111-111111111111';
const CURRENT = 'bbbbbbbb-2222-4222-8222-222222222222';

beforeEach(async () => {
  await rm(workersDirectory(), { recursive: true, force: true });
  resetCorpusCache();
  resetHarnessStateCaches();
  const state = await readState();
  state.sessions = [];
  await writeState(state);
  const messages: TranscriptMessage[] = [];
  for (let index = 0; index < 20; index += 1) {
    messages.push({ role: 'user', content: index === 12 ? 'Why does the token refresh retry loop spin? key sk-ant-SECRETSECRETSECRET123' : `question ${index}` });
    messages.push({ role: 'assistant', content: `answer ${index}`, ...(index === 12 ? { activities: [{ responseOffset: 0, event: { kind: 'tool-done' as const, label: '$ grep -rn refresh src', id: 'c1', output: ['src/auth.ts:10: refreshToken()', 'src/auth.ts:20: retry', 'src/auth.ts:30: more', 'src/auth.ts:40: more'] } }] } : {}) });
  }
  await store(
    chat(OTHER, messages, { name: 'Auth refresh bug' }),
    chat(CURRENT, [{ role: 'user', content: 'token refresh retry loop, from here' }], { name: 'This chat', provider: 'anthropic', nativeHarness: 'claude' }),
  );
});

describe('search_conversations', () => {
  it('returns compact ranked hits with anchors, without the current conversation', async () => {
    const result = await run('search_conversations', { query: 'token refresh retry' }, CURRENT);
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('Auth refresh bug — id aaaaaaaa · codex · gpt-5');
    expect(result.text).toContain('@aaaaaaaa:24 user:');
    expect(result.text).not.toContain('This chat');
    expect(result.text).not.toContain('SECRETSECRET');
    expect(result.text.length).toBeLessThan(1200);
    const withCurrent = await run('search_conversations', { query: 'token refresh retry', includeCurrent: true }, CURRENT);
    expect(withCurrent.text).toContain('This chat');
  });

  it('says so when nothing matches, and refuses a bad since', async () => {
    expect((await run('search_conversations', { query: 'nonexistent words' })).text).toMatch(/^No conversation mentions/);
    expect((await run('search_conversations', { query: 'x', since: 'whenever' })).isError).toBe(true);
    expect((await run('search_conversations', { query: '  ' })).isError).toBe(true);
  });
});

describe('search_conversations in one conversation', () => {
  it('lists every place in it, the current conversation included without includeCurrent', async () => {
    const inOther = await run('search_conversations', { query: 'answer', in: 'aaaaaaaa' }, CURRENT);
    expect(inOther.text).toMatch(/^"answer" in Auth refresh bug — id aaaaaaaa · codex · gpt-5 · 30m ago · 20 mentions/);
    expect(inOther.text.split('\n').filter((line) => line.startsWith('  @aaaaaaaa:'))).toHaveLength(20);
    const inCurrent = await run('search_conversations', { query: 'retry loop', in: CURRENT }, CURRENT);
    expect(inCurrent.text).toContain('@bbbbbbbb:0 user: token refresh retry loop, from here');
    expect((await run('search_conversations', { query: 'e', in: 'aaaaaaaa' })).text).toContain('(20 more messages;');
    expect((await run('search_conversations', { query: 'zebra', in: 'aaaaaaaa' })).text).toBe('"zebra" does not come up in aaaaaaaa.');
    expect((await run('search_conversations', { query: 'x', in: 'zzzzzzzz' })).isError).toBe(true);
  });
});

describe('one id per conversation', () => {
  it('anchors on the conversation, and still reads an anchor naming one of its chats', async () => {
    const shared: TranscriptMessage[] = Array.from({ length: 6 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `shared ${index}` }));
    const ROOT = 'cccccccc-3333-4333-8333-333333333333';
    const FORK = 'dddddddd-4444-4444-8444-444444444444';
    await store(chat(ROOT, [...shared, { role: 'user', content: 'the wombat in the trunk' }], { name: 'Wombats', conversationId: ROOT, updatedAt: minutesAgo(90) }));
    await store(chat(FORK, [...shared, { role: 'user', content: 'a wombat on the branch' }, { role: 'assistant', content: 'wombat noted' }], { name: 'Wombats', conversationId: ROOT, parentSessionId: ROOT, updatedAt: minutesAgo(10) }));
    const found = await run('search_conversations', { query: 'wombat' });
    expect(found.text).toContain('@cccccccc:6 user: a wombat on the branch');
    expect(found.text).toContain('@cccccccc:8 user: the wombat in the trunk');
    expect(found.text).not.toContain('dddddddd');
    const read = await run('read_conversation', { id: 'cccccccc', at: 'cccccccc:8', before: 1, after: 0 });
    expect(read.text).toContain('· 8 messages (+1 in other branches, #8–8)');
    expect(read.text).toContain('— another branch of it (codex · gpt-5), continuing from #5 —\n[#8 user] the wombat in the trunk');
    // The old form: the trunk chat's own index 6, and the fork's 7.
    expect((await run('read_conversation', { id: 'cccccccc', at: 'cccccccc:6', before: 0, after: 0 })).text).toContain('[#6 user] a wombat on the branch');
    expect((await run('read_conversation', { id: 'dddddddd', at: 'dddddddd:7', before: 0, after: 0 })).text).toContain('[#7 assistant] wombat noted');
    expect((await run('read_conversation', { id: ROOT, at: 'dddddddd:40' })).isError).toBe(true);
  });
});

describe('read_conversation', () => {
  it('reads one message whole with full, bounded by maxChars', async () => {
    const long = `${'alpha '.repeat(400)}omega`;
    const LONG = 'eeeeeeee-5555-4555-8555-555555555555';
    await store(chat(LONG, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: long }, { role: 'user', content: 'thanks' }], { name: 'Long one' }));
    const short = await run('read_conversation', { id: LONG, at: '1', maxChars: 1000 });
    expect(short.text).toMatch(/\[… \d+ chars\]/);
    expect(short.text).toContain('(shortened: #1; at=N full=true reads one whole)');
    const whole = await run('read_conversation', { id: LONG, at: '1', full: true });
    expect(whole.text).toContain(`[#1 assistant] ${long}`);
    expect(whole.text).not.toContain('[#2');
    const bounded = await run('read_conversation', { id: LONG, at: '1', full: true, maxChars: 600 });
    expect(bounded.text).toMatch(/more chars; raise maxChars\]$/);
    expect(bounded.text.length).toBeLessThan(700);
    const tool = await run('read_conversation', { id: OTHER, at: '25', full: true });
    expect(tool.text).toContain('src/auth.ts:40: more');
    expect((await run('read_conversation', { id: LONG, full: true })).text).toContain('[#2 user] thanks');
  });

  it('reads around an anchor, compacting tool calls and masking secrets', async () => {
    const result = await run('read_conversation', { id: 'aaaaaaaa', at: 'aaaaaaaa:24', before: 1, after: 1 });
    expect(result.text).toContain('messages 23–25');
    expect(result.text).toContain('[#24 user] Why does the token refresh retry loop spin?');
    expect(result.text).toContain('⏺ $ grep -rn refresh src');
    expect(result.text).toContain('src/auth.ts:20: retry');
    expect(result.text).not.toContain('src/auth.ts:30');
    expect(result.text).not.toContain('SECRETSECRET');
    expect(result.text).toContain('(more — earlier: at=22 · later: at=26)');
  });

  it('reads the latest turns without an anchor, and stays inside maxChars', async () => {
    const latest = await run('read_conversation', { id: OTHER });
    expect(latest.text).toContain('messages 34–39');
    expect(latest.text).toContain('[#39 assistant] answer 19');
    const bounded = await run('read_conversation', { id: OTHER, at: '24', before: 50, after: 50, maxChars: 1500 });
    expect(bounded.text.length).toBeLessThan(2600);
  });

  it('explains an unknown id or anchor', async () => {
    expect((await run('read_conversation', { id: 'zzzzzzzz' })).isError).toBe(true);
    expect((await run('read_conversation', { id: OTHER, at: 'soon' })).isError).toBe(true);
    expect((await run('read_conversation', { id: OTHER, at: '400' })).isError).toBe(true);
  });
});

describe('hindsight', () => {
  async function replaceCurrent(messages: TranscriptMessage[], extra: Partial<HarnessSession> = {}): Promise<void> {
    const state = await readState();
    const current = state.sessions.find((session) => session.id === CURRENT)!;
    Object.assign(current, extra, { messages });
    await writeState(state);
    resetCorpusCache();
  }

  it('is this chat, and says so when the call has none', async () => {
    expect((await run('hindsight', {})).text).toBe('hindsight is this conversation, and this call has none.');
    expect((await run('hindsight', { back: 1, query: 'x' }, CURRENT)).isError).toBe(true);
  });

  it('steps back one topic, quoting the decision and the files the turn log kept', async () => {
    const messages: TranscriptMessage[] = [
      { role: 'user', content: 'Publish the CLI through ClikDeploy' },
      { role: 'assistant', content: 'The publish workflow is in place.', origin: { harness: 'grok', route: 'local', provider: 'xai', model: 'grok-4' } },
      { role: 'user', content: 'Fix the quota reprint' },
      { role: 'assistant', content: 'Retried the same line.', activities: [{ responseOffset: 0, event: { kind: 'tool-done', label: 'Read src/turn/vendor-turn.ts', id: 't1', output: ['resumePrompt'] } }], origin: { harness: 'grok', route: 'local', provider: 'xai', model: 'grok-4.7' } },
      { role: 'user', content: 'that is a bandaid' },
      { role: 'assistant', content: 'Removed the patch.', origin: { harness: 'grok', route: 'local', provider: 'xai', model: 'grok-4.7' } },
      { role: 'user', content: 'ok do it' },
      { role: 'assistant', content: 'The patch is gone.' },
    ];
    await replaceCurrent(messages, {
      accountId: 'be5aaaf2-656e-4b8c-a6e1-3e2da14ad646',
      pendingTurn: {
        prompt: 'build the hindsight tool', startedAt: new Date(NOW - 60_000).toISOString(), updatedAt: new Date(NOW).toISOString(), outputStarted: true, response: '',
        activities: [{ responseOffset: 0, event: { kind: 'tool-start', label: 'Read src/search/tools.ts', id: 't2' } }],
      },
    });
    await appendTurnChanges(stateDirectory(), CURRENT, { at: new Date(NOW - 3 * 3_600_000).toISOString(), prompt: 'Publish the CLI through ClikDeploy', changes: [{ path: 'src/cli/register.ts', lines: [], additions: 1, removals: 0 }] });
    await appendTurnChanges(stateDirectory(), CURRENT, { at: new Date(NOW - 10 * 60_000).toISOString(), prompt: 'Fix the quota reprint', changes: [{ path: 'src/turn/vendor-turn.ts', lines: [], additions: 4, removals: 1 }] });
    const list = await run('hindsight', {}, CURRENT);
    expect(list.text).toContain('account be5aaaf2 now');
    expect(list.text).toContain('In progress: not in the transcript yet · in progress · claude · gpt-5');
    expect(list.text).toContain('build the hindsight tool');
    expect(list.text).toContain('1. #2–#7 · answered · grok grok-4.7');
    expect(list.text).toContain('2. #0–#1 · answered · grok grok-4');
    expect(list.text).not.toContain('Auth refresh bug');
    const back = await run('hindsight', { back: 1 }, CURRENT);
    expect(back.text).toContain('Topic back 1 of 2');
    expect(back.text).toContain('#4 "that is a bandaid"');
    expect(back.text).toContain('#6 "ok do it"');
    expect(back.text).toContain('files: src/turn/vendor-turn.ts (+4 -1)');
    expect(back.text).toContain('tools: Read src/turn/vendor-turn.ts');
    expect(back.text).toContain('finished: The patch is gone.');
    expect(back.text).toContain('not the current tree');
    const older = await run('hindsight', { back: 1, before: '30m' }, CURRENT);
    expect(older.text).toContain('Publish the CLI through ClikDeploy');
    expect(older.text).toContain('src/cli/register.ts');
    expect(older.text).not.toContain('that is a bandaid');
    const found = await run('hindsight', { query: 'resumePrompt' }, CURRENT);
    expect(found.text).toContain('#3 assistant (tool call)');
    const read = await run('hindsight', { from: 2, to: 3 }, CURRENT);
    expect(read.text).toContain('[#2 user] Fix the quota reprint');
    expect(read.text).toContain('⏺ Read src/turn/vendor-turn.ts');
    expect(read.text).toContain('resumePrompt');
  });
});

describe('active_conversations', () => {
  it('reports a working conversation, its step, and the approval it waits on', async () => {
    const state = await readState();
    const other = state.sessions.find((session) => session.id === OTHER)!;
    other.pendingTurn = {
      prompt: 'fix the refresh loop', startedAt: minutesAgo(3), updatedAt: minutesAgo(0), outputStarted: true, response: '',
      activities: [{ responseOffset: 0, event: { kind: 'tool-start', label: '$ pnpm test auth', id: 'r1' } }],
    };
    await writeState(state);
    await writeWorkerRecord({
      pid: process.pid, sessionId: OTHER, socketPath: '/nowhere', installationId: 'test', startedAt: minutesAgo(5), token: 't',
      awaitingApproval: { title: 'Run pnpm test auth?', since: minutesAgo(1) },
    });
    const result = await run('active_conversations', {}, CURRENT);
    expect(result.text).toContain('Auth refresh bug — id aaaaaaaa · codex · gpt-5 · working for 3m · last active just now');
    expect(result.text).toContain('WAITING FOR APPROVAL: Run pnpm test auth?');
    expect(result.text).toContain('asked: fix the refresh loop');
    expect(result.text).toContain('now: running $ pnpm test auth');
    expect(result.text).not.toContain('This chat');
  });

  it('lists a recently active conversation nothing runs', async () => {
    const result = await run('active_conversations', {}, CURRENT);
    expect(result.text).toContain('Auth refresh bug');
    expect(result.text).toContain('last active 30m ago');
  });
});
