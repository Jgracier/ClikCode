import { utimes, writeFile, readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HarnessSession, TranscriptMessage } from '../session/model.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { resetHarnessStateCaches } from '../session/state/index-file.js';
import { sessionFilePath } from '../session/store/paths.js';
import { loadSessionFile } from '../session/store/records.js';
import { corpusBuilds, resetCorpusCache, sessionDoc } from './corpus.js';
import { parseQuery, parseSince, recencyBoost, searchConversations } from './engine.js';
import { snippet } from './format.js';
import { maskSecrets } from './secrets.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const daysAgo = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();

function chat(id: string, messages: TranscriptMessage[], extra: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id, route: 'local', accountId: null, provider: 'anthropic', model: 'sonnet', effort: 'medium', permissionMode: 'ask',
    accountFailover: 'never', createdAt: daysAgo(30), updatedAt: daysAgo(1), status: 'active', nativeHarness: 'claude',
    messages, ...extra,
  } as HarnessSession;
}

const user = (content: string): TranscriptMessage => ({ role: 'user', content });
const assistant = (content: string, activities?: TranscriptMessage['activities']): TranscriptMessage => ({ role: 'assistant', content, ...(activities ? { activities } : {}) });

async function store(...sessions: HarnessSession[]): Promise<void> {
  const state = await readState();
  state.sessions.push(...sessions);
  await writeState(state);
}

beforeEach(async () => {
  resetCorpusCache();
  resetHarnessStateCaches();
  const state = await readState();
  state.sessions = [];
  await writeState(state);
});

describe('query parsing', () => {
  it('reads words, a phrase across any whitespace, and since', () => {
    const query = parseQuery('  "Recursive  Self improvement" ')!;
    expect(query.words).toEqual(['recursive', 'self', 'improvement']);
    expect('recursive\nself   improvement'.match(query.phrase)).toHaveLength(1);
    expect('recursive self-improvement'.match(query.phrase)).toHaveLength(1);
    expect(parseQuery('   ')).toBeUndefined();
    expect(parseSince('2d', NOW)).toBe(NOW - 2 * 86_400_000);
    expect(parseSince('12h', NOW)).toBe(NOW - 12 * 3_600_000);
    expect(parseSince('2026-10-01', NOW)).toBe(Date.parse('2026-10-01'));
    expect(parseSince('soon', NOW)).toBeUndefined();
  });
});

describe('searchConversations', () => {
  it('ranks the exact phrase above all-words, then by mentions', async () => {
    await store(
      chat('words-only', [user('self review of the recursive improvement plan'), assistant('improvement: recursive self checks'), user('recursive, self, improvement'), assistant('recursive / self / improvement')], { updatedAt: daysAgo(0) }),
      chat('one-exact', [user('Recursive self improvement once.')], { updatedAt: daysAgo(3) }),
      chat('two-exact', [user('recursive self improvement'), assistant('Yes, RECURSIVE SELF IMPROVEMENT.')], { updatedAt: daysAgo(3) }),
      chat('none', [user('nothing to see')]),
    );
    const result = (await searchConversations('recursive self improvement', { now: NOW }))!;
    expect(result.hits.map((hit) => hit.conversationId)).toEqual(['two-exact', 'one-exact', 'words-only']);
    expect(result.hits[0]!.mentions).toHaveLength(2);
    expect(result.hits[0]!.exactCount).toBe(2);
    expect(result.hits[2]!.exactCount).toBe(0);
    // One mention per message holding all the words.
    expect(result.hits[2]!.mentions.length).toBe(4);
  });

  it('boosts recent conversations with the same mentions', async () => {
    await store(
      chat('old', [user('the flaky deploy again')], { updatedAt: daysAgo(40) }),
      chat('new', [user('the flaky deploy again')], { updatedAt: daysAgo(1) }),
    );
    const result = (await searchConversations('flaky deploy', { now: NOW }))!;
    expect(result.hits.map((hit) => hit.conversationId)).toEqual(['new', 'old']);
    expect(recencyBoost(NOW, NOW)).toBeCloseTo(2.5);
    expect(recencyBoost(NOW - 7 * 86_400_000, NOW)).toBeCloseTo(1.75);
  });

  it('records each mention as conversation, message and offset', async () => {
    await store(chat('anchors', [user('first line\nthe needle here'), assistant('no'), user('needle and needle')]));
    const hit = (await searchConversations('needle', { now: NOW }))!.hits[0]!;
    expect(hit.mentions.map((mention) => [mention.sessionId, mention.messageIndex, mention.offset])).toEqual([
      ['anchors', 0, 15], ['anchors', 2, 0], ['anchors', 2, 11],
    ]);
  });

  it('searches stored tool calls, not only what was said', async () => {
    await store(chat('tools', [user('run the tests'), assistant('Done.', [
      { responseOffset: 0, event: { kind: 'tool-done', label: '$ pnpm vitest run', id: 't1', output: ['FAIL src/flux-capacitor.test.ts'] } },
    ])]));
    const hit = (await searchConversations('flux-capacitor', { now: NOW }))!.hits[0]!;
    expect(hit.mentions[0]!.messageIndex).toBe(1);
    const doc = (await sessionDoc('tools'))!;
    expect(hit.mentions[0]!.offset).toBeGreaterThanOrEqual(doc.messages[1]!.contentLength);
    expect(snippet(doc.messages[1]!, hit.mentions[0]!)).toContain('assistant (tool call)');
  });

  it('groups branches by conversation, counts a shared message once, titles it from the newest', async () => {
    const shared = [user('the parrot protocol'), assistant('parrot protocol explained')];
    await store(chat('root', shared, { name: 'Old title', updatedAt: daysAgo(5), conversationId: 'root' }));
    await store(chat('fork', [...shared, user('more parrot protocol')], { name: 'New title', updatedAt: daysAgo(1), conversationId: 'root', parentSessionId: 'root' }));
    // The fork is stored as a reference into its parent's history.
    expect((await loadSessionFile('fork'))?.transcriptRef?.sessionId).toBe('root');
    const result = (await searchConversations('parrot protocol', { now: NOW }))!;
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    expect(hit.conversationId).toBe('root');
    expect(hit.title).toBe('New title');
    expect(hit.sessionId).toBe('fork');
    expect(hit.mentions.map((mention) => [mention.sessionId, mention.messageIndex])).toEqual([['fork', 0], ['fork', 1], ['fork', 2]]);
  });

  it('leaves out blank chats, clerks and the excluded conversation', async () => {
    await store(
      chat('blank', []),
      chat('clerk', [user('banana split')], { clerkOf: 'host' } as Partial<HarnessSession>),
      chat('mine', [user('banana split')]),
      chat('theirs', [user('banana split')]),
    );
    const result = (await searchConversations('banana', { now: NOW, excludeConversationId: 'mine' }))!;
    expect(result.hits.map((hit) => hit.conversationId)).toEqual(['theirs']);
  });

  it('filters by since', async () => {
    await store(chat('old', [user('kiwi')], { updatedAt: daysAgo(10) }), chat('new', [user('kiwi')], { updatedAt: daysAgo(1) }));
    const result = (await searchConversations('kiwi', { now: NOW, sinceMs: NOW - 2 * 86_400_000 }))!;
    expect(result.hits.map((hit) => hit.conversationId)).toEqual(['new']);
  });
});

describe('the transcript cache', () => {
  it('reads a transcript once while its file is unchanged, and again when it changes', async () => {
    await store(chat('cached', [user('mango')]));
    await searchConversations('mango', { now: NOW });
    const built = corpusBuilds();
    await searchConversations('mango', { now: NOW });
    await searchConversations('papaya', { now: NOW });
    expect(corpusBuilds()).toBe(built);
    // Changed on disk by another process: new size and mtime.
    const path = sessionFilePath('cached');
    const file = JSON.parse(await readFile(path, 'utf8'));
    file.messages.push({ role: 'user', content: 'papaya' });
    await writeFile(path, JSON.stringify(file));
    const hit = (await searchConversations('papaya', { now: NOW }))!.hits[0];
    expect(hit?.conversationId).toBe('cached');
    expect(corpusBuilds()).toBe(built + 1);
  });

  it('notices a change by mtime even at the same size', async () => {
    await store(chat('same-size', [user('alpha one')]));
    await sessionDoc('same-size');
    const path = sessionFilePath('same-size');
    await writeFile(path, (await readFile(path, 'utf8')).replace('alpha one', 'omega one'));
    const later = new Date(Date.now() + 5000);
    await utimes(path, later, later);
    expect((await sessionDoc('same-size'))!.messages[0]!.text).toBe('omega one');
  });

  it('keys a fork on its parent file too', async () => {
    const shared = [user('alpha one'), assistant('beta two')];
    await store(chat('parent', shared, { conversationId: 'parent' }));
    await store(chat('child', [...shared, user('gamma')], { conversationId: 'parent', parentSessionId: 'parent' }));
    await sessionDoc('child');
    const built = corpusBuilds();
    await sessionDoc('child');
    expect(corpusBuilds()).toBe(built);
    const later = new Date(Date.now() + 5000);
    await utimes(sessionFilePath('parent'), later, later);
    expect((await sessionDoc('child'))!.messages.map((message) => message.text)).toEqual(['alpha one', 'beta two', 'gamma']);
    expect(corpusBuilds()).toBe(built + 1);
  });
});

describe('maskSecrets', () => {
  it('masks keys, tokens, private keys, bearer and JWTs', () => {
    const text = [
      'key sk-ant-api03-abcdefghijklmnopqrstuvwx',
      'gh token ghp_abcdefghijklmnopqrstuvwxyz0123',
      'Authorization: Bearer abc.def-123456789',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'OPENAI_API_KEY=abcd1234efgh5678',
      '"X-Brain-Key: 2c727b912e0c9911b9c4d34f23b439bb"',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----',
      'AKIAIOSFODNN7EXAMPLE',
    ].join('\n');
    const masked = maskSecrets(text);
    for (const secret of ['abcdefghijklmnopqrstuvwx', 'ghp_abcdef', 'abc.def-123456789', 'eyJhbGci', 'abcd1234efgh5678', '2c727b912e0c', 'b3BlbnNzaC1rZXktdjEAAAAA', 'AKIAIOSFODNN7EXAMPLE']) {
      expect(masked).not.toContain(secret);
    }
    expect(masked).toContain('OPENAI_API_KEY=[secret]');
  });

  it('keeps what only looks key-ish', () => {
    const text = 'commit 3c78a4725f0e9d1c2b3a4f5e6d7c8b9a0f1e2d3c, the token is expired, token: tokenFor(user), password field';
    expect(maskSecrets(text)).toBe(text);
  });

  it('masks every snippet', async () => {
    await store(chat('leaky', [user('use sk-proj-ABCDEFGHIJKLMNOP1234567890 for the canary deploy')]));
    const hit = (await searchConversations('canary', { now: NOW }))!.hits[0]!;
    const doc = (await sessionDoc('leaky'))!;
    const shown = snippet(doc.messages[0]!, hit.mentions[0]!);
    expect(shown).toContain('canary');
    expect(shown).not.toContain('ABCDEFGHIJKLMNOP');
  });
});
