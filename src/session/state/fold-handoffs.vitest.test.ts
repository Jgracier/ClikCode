/** Conversations stored as one branch per provider switch read back as one
 * conversation: older branches folded (kept, not listed), who answered each
 * turn stamped on it, forks and branches that went their own way left alone.
 * CLIKCODE_HOME is throwaway. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessSession, TranscriptMessage } from '../model.js';
import { canonicalRecord } from '../canonical.js';
import { conversationRows } from '../conversation-rows.js';
import { readState } from './read.js';
import { writeState } from './write.js';

const saved = process.env.CLIKCODE_HOME;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-fold-'));
  process.env.CLIKCODE_HOME = root;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = saved;
  await rm(root, { recursive: true, force: true });
});

const user = (content: string): TranscriptMessage => ({ role: 'user', content });
const said = (content: string): TranscriptMessage => ({ role: 'assistant', content });
const at = (minute: number): string => `2026-10-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

function chat(id: string, harness: string, minute: number, messages: TranscriptMessage[], parent?: string, handoff = true): HarnessSession {
  return {
    id, conversationId: 'root', route: 'local', accountId: null, provider: harness, model: `${harness}-model`, nativeHarness: harness,
    effort: 'medium', accountFailover: 'never', createdAt: at(minute), updatedAt: at(minute), status: 'active', messages,
    nativeSessionId: `${harness}-thread`,
    ...(parent ? { parentSessionId: parent, ...(handoff ? { handoff: { fromSessionId: parent, fromHarness: 'x', at: at(minute) } } : {}) } : {}),
  } as HarnessSession;
}

/** root (claude) -> a (codex) -> b (kilo, newest); a also forked; root also
 * handed off to c (gemini), which went its own way. */
async function store(): Promise<void> {
  const first = [user('codeword is PLUM'), said('noted')];
  const second = [...first, user('repeat it'), said('PLUM')];
  const third = [...second, user('again'), said('PLUM again')];
  const state = await readState();
  state.sessions.push(
    { ...chat('root', 'claude', 1, first), conversationId: 'root' },
    chat('a', 'codex', 2, second, 'root'),
    chat('b', 'kilo', 5, third, 'a'),
    chat('fork', 'codex', 4, [...second, user('fork turn'), said('forked')], 'a', false),
    chat('c', 'gemini', 3, [...first, user('other way'), said('went')], 'root'),
  );
  await writeState(state);
}

describe('folding handoff branches', () => {
  it('folds each branch into the newest that carries its whole history, and stamps who answered', async () => {
    await store();
    const sessions = (await readState()).sessions;
    const byId = new Map(sessions.map((session) => [session.id, session]));
    // root is carried whole by both a and c; the newer one takes it.
    expect(byId.get('root')!.foldedInto).toBe('c');
    expect(byId.get('a')!.foldedInto).toBe('b');
    for (const id of ['b', 'c', 'fork']) expect(byId.get(id)!.foldedInto).toBeUndefined();
    expect(sessions.some((session) => 'handoff' in session)).toBe(false);
    // Nothing deleted, the old thread ids intact.
    expect(byId.get('root')).toMatchObject({ nativeSessionId: 'claude-thread', messages: [user('codeword is PLUM'), expect.objectContaining({ content: 'noted' })] });
    // The record needs no chain any more.
    expect(canonicalRecord(byId.get('b')!).turns.map((turn) => turn.origin.harness)).toEqual(['claude', 'codex', 'kilo']);
    expect(canonicalRecord(byId.get('fork')!).turns.map((turn) => turn.origin.harness)).toEqual(['claude', 'codex', 'codex']);
    expect(canonicalRecord(byId.get('c')!).turns.map((turn) => turn.origin.harness)).toEqual(['claude', 'gemini']);
    // One row, listing only the chats that are still conversations.
    const [row, ...rest] = conversationRows(sessions);
    expect(rest).toEqual([]);
    expect(row!.latest.id).toBe('b');
    expect(row!.chats.map((session) => session.id).sort()).toEqual(['b', 'c', 'fork']);
  });

  it('runs once: a second read changes nothing on disk', async () => {
    await store();
    await readState();
    const before = await readFile(join(root, 'index.json'), 'utf8');
    await readState();
    expect(await readFile(join(root, 'index.json'), 'utf8')).toBe(before);
  });

  it('leaves a branch that went on after the switch, or has something queued, listed', async () => {
    const first = [user('one'), said('1')];
    const state = await readState();
    state.sessions.push(
      { ...chat('root', 'claude', 1, [...first, user('kept going'), said('here')]) },
      chat('a', 'codex', 2, [...first, user('two'), said('2')], 'root'),
      { ...chat('q', 'claude', 3, first), conversationId: 'q', queuedTurns: [{ id: 'x', text: 'later', submittedAt: at(3) }] },
      { ...chat('qa', 'codex', 4, [...first, user('three'), said('3')], 'q'), conversationId: 'q' },
    );
    await writeState(state);
    const sessions = (await readState()).sessions;
    expect(sessions.filter((session) => session.foldedInto)).toEqual([]);
  });
});
