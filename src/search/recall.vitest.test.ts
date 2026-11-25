import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import type { HarnessSession, TranscriptMessage } from '../session/model.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { resetHarnessStateCaches } from '../session/state/index-file.js';
import { conversationGroups, findConversation } from './conversations.js';
import { resetCorpusCache } from './corpus.js';
import { setEmbedderForTests, type Embedder } from './embedder.js';
import { indexConversation, resetVectorCache, vectorFilePath } from './vectors.js';
import { RECALL_MAX_CHARS, agentRecallBoundary, distinctiveWords, recall, withRecall } from './recall.js';
import { stripResourceNotes } from '../turn/resource-note-text.js';
import { requestKey } from '../session/store-evidence.js';
import { recallBoundary } from '../turn/compaction.js';
import { TOPIC_CONTENTS_MAX_CHARS, topicContentsText } from './topic-contents.js';

/** One dimension per concept; any other word lands faintly in a hashed one (as vectors.vitest.test.ts). */
const CONCEPTS: string[][] = [
  ['login', 'signin', 'authenticate', 'authentication', 'credentials', 'password', 'oauth'],
  ['database', 'postgres', 'sql', 'migration', 'schema', 'table'],
];
class FakeEmbedder implements Embedder {
  readonly id = 'fake-1';
  readonly dims = 64;
  delayMs = 0;
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return texts.map((text) => {
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
    });
  }
}

const A = 'aaaaaaaa-7777-4777-8777-777777777777';

function chat(messages: TranscriptMessage[]): HarnessSession {
  const at = new Date().toISOString();
  return {
    id: A, route: 'local', accountId: null, provider: 'anthropic', model: 'claude-x', effort: 'medium', permissionMode: 'ask',
    createdAt: at, updatedAt: at, status: 'active', nativeHarness: 'claude', workspace: '/work/app', name: 'Recall', messages,
  } as HarnessSession;
}

async function store(messages: TranscriptMessage[]): Promise<void> {
  const state = await readState();
  state.sessions = [...state.sessions.filter((session) => session.id !== A), chat(messages)];
  await writeState(state);
  resetCorpusCache();
  resetHarnessStateCaches();
}

/** 40 messages about a postgres migration; #6 names the deploy key, #17 is about the login page. */
function longChat(): TranscriptMessage[] {
  const messages: TranscriptMessage[] = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `step ${index}: the postgres table migration` }));
  messages[6] = { role: 'user', content: 'Use the deploy key ck_live_7f3a9 and never the old one.' };
  messages[17] = { role: 'assistant', content: 'Reset the oauth password for the login page' };
  return messages;
}

let embedder: FakeEmbedder;
beforeEach(async () => {
  embedder = new FakeEmbedder();
  setEmbedderForTests(embedder);
  resetVectorCache();
  await rm(vectorFilePath(A), { force: true });
});
afterEach(() => setEmbedderForTests(undefined));

describe('automatic recall', () => {
  it('attaches nothing while the context holds every message, or for a short or continuing request', async () => {
    await store(longChat());
    expect((await recall({ sessionId: A, query: 'which deploy key ck_live_7f3a9 again?', boundary: 0, hasHindsight: true })).skipped).toBe('no-boundary');
    expect((await recall({ sessionId: A, query: 'ok go ahead', boundary: 30, hasHindsight: true })).skipped).toBe('short');
    expect((await recall({ sessionId: A, query: 'make the changes', boundary: 30, hasHindsight: true })).skipped).toBe('continuation');
  });

  it('finds an identifier only the compacted part has, and not one the context still holds', async () => {
    await store(longChat());
    const found = await recall({ sessionId: A, query: 'Rotate the ck_live_7f3a9 key now please', boundary: 30, hasHindsight: true });
    expect(found.hits.map((hit) => [hit.position, hit.by])).toEqual([[6, 'words']]);
    // Whole, since it fits: nothing left for hindsight to read.
    expect(found.note).toContain('#6 user: Use the deploy key ck_live_7f3a9 and never the old one.');
    expect(found.note).not.toContain('hindsight(');
    // The same words after the boundary: already in context, so nothing.
    const held = await recall({ sessionId: A, query: 'Rotate the ck_live_7f3a9 key now please', boundary: 4, hasHindsight: true });
    expect(held.hits).toEqual([]);
    expect(held.note).toBeUndefined();
  });

  it('by meaning only when one message stands out of the conversation', async () => {
    const messages = longChat();
    await store(messages);
    await indexConversation(findConversation(await conversationGroups(), A)!.group, embedder);
    const login = await recall({ sessionId: A, query: 'how did we authenticate credentials before?', boundary: 30, hasHindsight: false });
    expect(login.hits.map((hit) => [hit.position, hit.by])).toEqual([[17, 'meaning']]);
    expect(login.note).not.toContain('hindsight(');
    expect(login.note).toContain('#17 assistant: Reset the oauth password for the login page');
    // Near every message is near none in particular: none leads the rest, so nothing is attached.
    const broad = await recall({ sessionId: A, query: 'what about the sql schema work', boundary: 30, hasHindsight: true });
    expect(broad.hits).toEqual([]);
    expect(broad.note).toBeUndefined();
    // Outside the boundary only: #17 is in the context when the boundary is before it.
    expect((await recall({ sessionId: A, query: 'how did we authenticate credentials before?', boundary: 10, hasHindsight: true })).hits).toEqual([]);
  });

  it('is time-boxed: a slow embedder means lexical alone, and the turn is not held', async () => {
    await store(longChat());
    await indexConversation(findConversation(await conversationGroups(), A)!.group, embedder);
    embedder.delayMs = 5_000;
    const started = Date.now();
    const found = await recall({ sessionId: A, query: 'how did we authenticate credentials before?', boundary: 30, hasHindsight: true, budgetMs: 200 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(found.hits).toEqual([]);
    expect(found.skipped).toBe('timeout');
    // No embedder at all: the words still work.
    setEmbedderForTests(null);
    expect((await recall({ sessionId: A, query: 'Rotate the ck_live_7f3a9 key now please', boundary: 30, hasHindsight: true, budgetMs: 200 })).hits.map((hit) => hit.position)).toEqual([6]);
  });

  it('appends after the request, so the text before it is the request unchanged, and reads back as the request', async () => {
    await store(longChat());
    const request = 'Rotate the ck_live_7f3a9 key now please';
    const prefix = `<clikcode_resource_note>\nmoved\n</clikcode_resource_note>\n\n${request}`;
    const sent = await withRecall({ sessionId: A, query: request, boundary: 30, hasHindsight: true }, prefix);
    expect(sent.startsWith(prefix)).toBe(true);
    expect(sent.length).toBeGreaterThan(prefix.length);
    expect(sent.length - prefix.length).toBeLessThan(RECALL_MAX_CHARS + 400);
    expect(stripResourceNotes(sent)).toBe(request);
    expect(requestKey(sent)).toBe(request);
    // Nothing found: the text is returned as it is.
    expect(await withRecall({ sessionId: A, query: 'nothing here matches at all', boundary: 30, hasHindsight: true }, prefix)).toBe(prefix);
  });

  it('keeps each message short and at most three', async () => {
    const messages = longChat();
    for (const at of [2, 4, 8, 10]) messages[at] = { role: 'user', content: `${'x '.repeat(3000)} build-id-${at} ${'y '.repeat(3000)}` };
    await store(messages);
    const found = await recall({ sessionId: A, query: 'Compare build-id-2 build-id-4 build-id-8 build-id-10 outputs', boundary: 30, hasHindsight: true });
    expect(found.hits).toHaveLength(3);
    expect(found.note!.length).toBeLessThan(RECALL_MAX_CHARS + 400);
    // Too long to go whole: excerpts, and the way to the rest.
    expect(found.note).toContain('These are excerpts; hindsight(at=<number>) reads one whole.');
  });
});

describe('recall boundaries', () => {
  it('distinctive words are identifiers, paths and quoted phrases, not plain words', () => {
    expect(distinctiveWords('please fix src/turn/compaction.ts and the "state only summary" for commit cdb7d397 in fooBar'))
      .toEqual(expect.arrayContaining(['src/turn/compaction.ts', 'state only summary', 'cdb7d397', 'foobar']));
    expect(distinctiveWords('please fix the thing we talked about')).toEqual([]);
  });

  it('a vendor thread holds the messages after its latest compaction or fitted start', () => {
    const messages = Array.from({ length: 10 }, () => ({ role: 'user' }));
    expect(recallBoundary({ messages })).toBe(0);
    expect(recallBoundary({ messages, compaction: { at: '', through: 6 } })).toBe(6);
    expect(recallBoundary({ messages, compaction: { at: '', through: 6 }, recallFrom: 8 })).toBe(8);
    expect(recallBoundary({ messages, recallFrom: 40 })).toBe(10);
  });

  it('the own agent: nothing while its memory fits the budget, else what is past the newest part that fits', () => {
    const messages = Array.from({ length: 10 }, () => ({ content: 'x'.repeat(384) }));
    expect(agentRecallBoundary(messages, 4_000, 2_000, 4)).toBe(0);
    expect(agentRecallBoundary(messages, 4_000, undefined, 4)).toBe(0);
    // 10 messages of 400 bytes each, a budget of 1,000 tokens (4,000 bytes) for a memory of 8,000: the newest five fit.
    expect(agentRecallBoundary(messages, 8_000, 1_000, 4)).toBe(5);
  });
});

describe('topic contents after a compaction', () => {
  const asked = (texts: string[]) => texts.flatMap((text, at) => [
    { index: at * 2, role: 'user' as const, content: text }, { index: at * 2 + 1, role: 'assistant' as const, content: 'done' },
  ]);

  it('one line per topic with its message numbers; a continuation stays in its topic', () => {
    const text = topicContentsText(asked(['Add the login page to src/app.tsx', 'continue', 'Now migrate the postgres table']), false)!;
    expect(text.split('\n')).toEqual([
      "This conversation's topics, by message number:",
      '#0–#3: Add the login page to src/app.tsx',
      '#4–#5: Now migrate the postgres table',
    ]);
    expect(topicContentsText([], true)).toBeUndefined();
  });

  it('keeps the newest topics within about 1k tokens, and the older ones as periods', () => {
    const subjects = ['voice latency', 'mobile connectors', 'gateway models', 'compaction tokens'];
    const requests = Array.from({ length: 200 }, (_, at) => `Request number ${at} about ${subjects[Math.floor(at / 50)]} ${'something else entirely '.repeat(6)}`);
    const text = topicContentsText(asked(requests), true)!;
    expect(text.length).toBeLessThanOrEqual(TOPIC_CONTENTS_MAX_CHARS);
    expect(text).toContain('#398–#399: Request number 199');
    expect(text).toContain('Earlier, by period');
    // The whole conversation stays on the map: the first period starts at the first message.
    expect(text).toMatch(/\n#0–#\d+ \(\d+ topics\): [^\n]*voice/);
    expect(text).not.toContain('earlier topics not listed');
  });

  it('lists only the newest topics with CLIKCODE_EVAL_TOPIC_PERIODS=0', () => {
    vi.stubEnv('CLIKCODE_EVAL_TOPIC_PERIODS', '0');
    try {
      const text = topicContentsText(asked(Array.from({ length: 200 }, (_, at) => `Request number ${at} about ${'something else entirely '.repeat(6)}`)), true)!;
      expect(text.length).toBeLessThanOrEqual(TOPIC_CONTENTS_MAX_CHARS);
      expect(text).toMatch(/\(\d+ earlier topics not listed\)/);
      expect(text).toContain('#398–#399: Request number 199');
    } finally { vi.unstubAllEnvs(); }
  });
});
