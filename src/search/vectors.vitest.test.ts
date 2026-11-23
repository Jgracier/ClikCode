import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import type { HarnessSession, TranscriptMessage } from '../session/model.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { resetHarnessStateCaches } from '../session/state/index-file.js';
import { deleteConversations } from '../session/state/deletions.js';
import { conversationGroups, findConversation } from './conversations.js';
import { conversationView, resetCorpusCache } from './corpus.js';
import { setEmbedderForTests, type Embedder } from './embedder.js';
import { CONVERSATION_TOOLS } from './tools.js';
import { CHUNK_CHARS, chunkMessage, indexConversation, resetVectorCache, semanticMatches, vectorFilePath } from './vectors.js';

/** Meaning without shared words: each concept is one dimension, its words
 * point there; any other word lands, faintly, in a hashed one. */
const CONCEPTS: string[][] = [
  ['login', 'signin', 'sign-in', 'authenticate', 'authentication', 'credentials', 'password', 'oauth'],
  ['database', 'postgres', 'sql', 'migration', 'schema', 'table'],
  ['deploy', 'release', 'ship', 'rollout', 'publish'],
  ['broken', 'failing', 'fails', 'error', 'crash', 'bug', 'failure'],
];
class FakeEmbedder implements Embedder {
  readonly id = 'fake-1';
  readonly dims = 64;
  texts: string[] = [];
  embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.texts.push(...texts);
    return Promise.resolve(texts.map((text) => {
      const vector = new Float32Array(this.dims);
      for (const word of text.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean)) {
        const concept = CONCEPTS.findIndex((words) => words.includes(word));
        if (concept >= 0) vector[concept] = vector[concept]! + 3;
        else {
          let hash = 7;
          for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
          vector[8 + (hash % 56)] = vector[8 + (hash % 56)]! + 0.3;
        }
      }
      const norm = Math.hypot(...vector) || 1;
      return vector.map((value) => value / norm);
    }));
  }
}

const NOW = Date.now();
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();
const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';

function chat(id: string, name: string, messages: TranscriptMessage[], minutesAgo = 30): HarnessSession {
  return {
    id, route: 'local', accountId: null, provider: 'anthropic', model: 'claude-x', effort: 'medium', permissionMode: 'ask',
    createdAt: iso(600), updatedAt: iso(minutesAgo), status: 'active', nativeHarness: 'claude', workspace: '/work/app', name, messages,
  } as HarnessSession;
}

async function store(...sessions: HarnessSession[]): Promise<void> {
  const state = await readState();
  const ids = new Set(sessions.map((session) => session.id));
  state.sessions = [...state.sessions.filter((session) => !ids.has(session.id)), ...sessions];
  await writeState(state);
  resetCorpusCache();
  resetHarnessStateCaches();
}

async function group(id: string) {
  return findConversation(await conversationGroups(), id)!.group;
}

const run = (name: string, args: Record<string, unknown>, currentSessionId?: string) =>
  CONVERSATION_TOOLS.find((tool) => tool.name === name)!.run(args, { ...(currentSessionId ? { currentSessionId } : {}), now: NOW });

let embedder: FakeEmbedder;
beforeEach(async () => {
  embedder = new FakeEmbedder();
  setEmbedderForTests(embedder);
  resetVectorCache();
  for (const id of [A, B, C]) await rm(vectorFilePath(id), { force: true });
  const state = await readState();
  deleteConversations(state, state.sessions.map((session) => session.id).filter((id) => ![A, B, C].includes(id)));
  state.sessions = state.sessions.filter((session) => [A, B, C].includes(session.id) || !session.id);
  await writeState(state);
});
afterEach(() => setEmbedderForTests(undefined));

describe('chunkMessage', () => {
  it('cuts long words into overlapping windows, packs tool calls, and drops what says nothing', () => {
    const content = Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ');
    const tools = ['  ⏺ $ grep -rn refreshToken src', ...Array.from({ length: 40 }, (_, index) => `    src/auth.ts:${index}: refreshToken()`), '  ⏺ Read src/auth.ts', '    export function refreshToken() {}'].join('\n');
    const text = `${content}\n${tools}`;
    const chunks = chunkMessage({ text, contentLength: content.length });
    const words = chunks.filter((chunk) => chunk.offset < content.length);
    expect(words.length).toBeGreaterThan(2);
    for (const chunk of words) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_CHARS);
      expect(text.slice(chunk.offset, chunk.offset + chunk.length)).toBe(chunk.text);
    }
    expect(words[1]!.offset).toBeLessThan(words[0]!.offset + words[0]!.length); // overlap
    const calls = chunks.filter((chunk) => chunk.offset >= content.length);
    expect(calls).toHaveLength(1); // both calls, output cut short, in one chunk
    expect(calls[0]!.text).toContain('⏺ $ grep -rn refreshToken src');
    expect(calls[0]!.text).toContain('⏺ Read src/auth.ts');
    expect(calls[0]!.text).not.toContain('src/auth.ts:39');
    expect(text.slice(calls[0]!.offset)).toMatch(/^ {2}⏺ \$ grep/);
    expect(chunkMessage({ text: 'ok go on', contentLength: 8 })).toEqual([]);
  });
});

describe('indexConversation', () => {
  it('embeds only what is new, keeps chunk metadata, and follows edits by fingerprint', async () => {
    const messages: TranscriptMessage[] = [
      { role: 'user', content: 'The login page is broken after the oauth change' },
      { role: 'assistant', content: 'Fixed the credentials check in the authentication middleware' },
    ];
    await store(chat(A, 'Auth', messages));
    const first = await indexConversation(await group(A), embedder, { now: NOW });
    expect(first).toEqual({ embedded: 2, pending: 0 });
    const lines = (await readFile(vectorFilePath(A), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toEqual({ embedder: 'fake-1', dims: 64 });
    expect(lines[1]).toMatchObject({ conversation: A, session: A, index: 1, message: 1, role: 'assistant', workspace: '/work/app', harness: 'claude', provider: 'anthropic', model: 'claude-x' });
    expect(typeof lines[1]!.at).toBe('string');

    expect(await indexConversation(await group(A), embedder)).toEqual({ embedded: 0, pending: 0 });
    expect(embedder.texts).toHaveLength(2);

    await store(chat(A, 'Auth', [...messages, { role: 'user', content: 'Now ship the release to production servers' }]));
    expect(await indexConversation(await group(A), embedder)).toEqual({ embedded: 1, pending: 0 });
    expect(embedder.texts.at(-1)).toContain('ship the release');

    // An edited message is a new fingerprint: embedded again; the old record no longer matches anything.
    await store(chat(A, 'Auth', [{ role: 'user', content: 'The database migration is failing on the users table' }, messages[1]!]));
    expect(await indexConversation(await group(A), embedder)).toEqual({ embedded: 1, pending: 0 });
    const view = await conversationView(await group(A));
    const [query] = await embedder.embed(['release rollout']);
    expect(await semanticMatches(await group(A), view, query!, 'fake-1')).toEqual([]);
  });

  it('in a long chat, a match must stand out from the rest, not just clear the floor', async () => {
    const messages: TranscriptMessage[] = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `step ${index}: the postgres table migration` }));
    messages[17] = { role: 'assistant', content: 'Reset the oauth password for the login page' };
    await store(chat(A, 'Long', messages));
    await indexConversation(await group(A), embedder);
    const view = await conversationView(await group(A));
    const [login] = await embedder.embed(['authenticate credentials']);
    expect((await semanticMatches(await group(A), view, login!, 'fake-1')).map((match) => match.position)).toEqual([17]);
    // Close to nearly every message is close to none in particular.
    const [database] = await embedder.embed(['sql schema']);
    expect(await semanticMatches(await group(A), view, database!, 'fake-1')).toEqual([]);
  });

  it('stops at its deadline and picks up where it left off', async () => {
    const messages: TranscriptMessage[] = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `message number ${index} about the postgres schema` }));
    await store(chat(A, 'Long', messages));
    const partial = await indexConversation(await group(A), embedder, { deadline: Date.now() - 1 });
    expect(partial).toEqual({ embedded: 0, pending: 40 });
    const rest = await indexConversation(await group(A), embedder);
    expect(rest).toEqual({ embedded: 40, pending: 0 });
  });
});

describe('hybrid search', () => {
  beforeEach(async () => {
    await store(
      chat(A, 'Socket work', [
        { role: 'user', content: 'The worker died with ERR_SOCKET_7731 when the pool drained' },
        { role: 'assistant', content: 'Traced ERR_SOCKET_7731 to the reconnect path' },
      ], 300),
      chat(B, 'Sign-in trouble', [
        { role: 'user', content: 'Users cannot authenticate, the oauth credentials step fails' },
        { role: 'assistant', content: 'The password grant was rejected by the provider' },
      ], 200),
      chat(C, 'This chat', [{ role: 'user', content: 'Publish the docs site' }, { role: 'assistant', content: 'Published.' }], 1),
    );
    for (const id of [A, B, C]) await indexConversation(await group(id), embedder);
  });

  it('an exact identifier beats a neighbour in meaning', async () => {
    const result = await run('search_conversations', { query: 'ERR_SOCKET_7731' }, C);
    expect(result.text).toMatch(/^"ERR_SOCKET_7731": 1 conversation/);
    expect(result.text).toContain('1. Socket work');
  });

  it('finds a match in meaning that shares no word with the query', async () => {
    const result = await run('search_conversations', { query: 'login broken' }, C);
    expect(result.text).toContain('1. Sign-in trouble');
    expect(result.text).toContain('related in meaning');
    expect(result.text).toMatch(/@bbbbbbbb:\d related · /);
  });

  it('falls back to words alone with no embedder', async () => {
    setEmbedderForTests(null);
    expect((await run('search_conversations', { query: 'login broken' }, C)).text).toContain('No conversation mentions "login broken"');
    expect((await run('search_conversations', { query: 'ERR_SOCKET_7731' }, C)).text).toContain('1. Socket work');
  });

  it('hindsight query: exact matches first, then related ones, each under its topic', async () => {
    await store(
      chat(B, 'Sign-in trouble', [
        { role: 'user', content: 'Deploy the api to staging' },
        { role: 'assistant', content: 'Rolled out build 4471 with ERR_PIPE_9 retries' },
        { role: 'user', content: 'Users cannot authenticate, the oauth credentials step fails' },
        { role: 'assistant', content: 'The password grant was rejected by the provider' },
      ], 5),
    );
    const found = await run('hindsight', { query: 'login broken' }, B);
    expect(found.text).toContain('"login broken" does not come up word for word in this chat.');
    expect(found.text).toContain('Related in meaning:');
    expect(found.text).toMatch(/#2–#3 · Users cannot authenticate.* · the latest topic\n {2}#2 user: Users cannot authenticate/);
    expect(found.text).not.toContain('#0 user');
    const exact = await run('hindsight', { query: 'ERR_PIPE_9' }, B);
    expect(exact.text).toMatch(/"ERR_PIPE_9" in this chat:\n#0–#1 · Deploy the api to staging · hindsight\(back=1\)\n {2}#1 assistant: /);
    setEmbedderForTests(null);
    const lexical = await run('hindsight', { query: 'login broken' }, B);
    expect(lexical.text).toContain('"login broken" does not come up in this chat.');
  });
});
