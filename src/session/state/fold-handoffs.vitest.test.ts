/** Conversations stored as one branch per provider switch read back as one
 * chat history: every switch-made branch folded (kept, not listed) into the
 * newest, turns it alone held merged in where they happened, who answered
 * each turn stamped on it; forks left alone. CLIKCODE_HOME is throwaway. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessSession, TranscriptMessage } from '../model.js';
import { canonicalRecord } from '../canonical.js';
import { conversationRows } from '../conversation-rows.js';
import { conversationOption } from '../options.js';
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
  // A fork made by this build carries the marker; a branch from an older one
  // may still carry `handoff`, and from the last one before this, nothing.
  return {
    id, conversationId: 'root', route: 'local', accountId: null, provider: harness, model: `${harness}-model`, nativeHarness: harness,
    effort: 'medium', createdAt: at(minute), updatedAt: at(minute), status: 'active', messages,
    nativeSessionId: `${harness}-thread`,
    ...(parent ? { parentSessionId: parent, ...(handoff ? { handoff: { fromSessionId: parent, fromHarness: 'x', at: at(minute) } } : { fork: true }) } : {}),
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
  it('folds every switch-made branch into the newest, merging what only it held, and stamps who answered', async () => {
    await store();
    const sessions = (await readState()).sessions;
    const byId = new Map(sessions.map((session) => [session.id, session]));
    for (const id of ['root', 'a', 'c']) expect(byId.get(id)!.foldedInto).toBe('b');
    for (const id of ['b', 'fork']) expect(byId.get(id)!.foldedInto).toBeUndefined();
    expect(sessions.some((session) => 'handoff' in session)).toBe(false);
    // Nothing deleted, the old thread ids intact.
    expect(byId.get('root')).toMatchObject({ nativeSessionId: 'claude-thread', messages: [user('codeword is PLUM'), expect.objectContaining({ content: 'noted' })] });
    // c's turn is in b's history, after a's turn (a was made before c) and
    // before b's own (b was made after it), stamped with who answered it.
    expect(byId.get('b')!.messages!.map((message) => message.content))
      .toEqual(['codeword is PLUM', 'noted', 'repeat it', 'PLUM', 'other way', 'went', 'again', 'PLUM again']);
    expect(canonicalRecord(byId.get('b')!).turns.map((turn) => turn.origin.harness)).toEqual(['claude', 'codex', 'gemini', 'kilo']);
    expect(canonicalRecord(byId.get('fork')!).turns.map((turn) => turn.origin.harness)).toEqual(['claude', 'codex', 'codex']);
    // One row: the history and its fork.
    const [row, ...rest] = conversationRows(sessions);
    expect(rest).toEqual([]);
    expect(row!.latest.id).toBe('b');
    expect(row!.chats.map((session) => session.id).sort()).toEqual(['b', 'fork']);
    // Its Branches are the history and the fork, nothing a switch made.
    expect(conversationOption(row!).alternates!.map((option) => [option.value, / · (original|fork)/.exec(option.label)?.[1]]))
      .toEqual([['fork', 'fork'], ['b', 'original']]);
  });

  it('runs once: a second read changes nothing on disk', async () => {
    await store();
    await readState();
    const before = await readFile(join(root, 'index.json'), 'utf8');
    await readState();
    expect(await readFile(join(root, 'index.json'), 'utf8')).toBe(before);
  });

  it('folds branches an earlier fold left listed: an empty switch, and one beside the line that went on', async () => {
    const first = [user('one'), said('1')];
    const state = await readState();
    // No handoff markers any more: the earlier fold dropped them.
    const branch = (session: HarnessSession): HarnessSession => { const { handoff: _, ...rest } = session as HarnessSession & { handoff?: unknown }; return rest as HarnessSession; };
    state.sessions.push(
      { ...chat('root', 'claude', 1, first), foldedInto: 'main' },
      branch(chat('empty', 'grok', 2, first, 'root')),
      branch(chat('side', 'cursor', 3, [...first, user('side'), said('s')], 'root')),
      branch({ ...chat('main', 'cursor', 4, [...first, user('main'), said('m')], 'root') }),
      { ...chat('named', 'claude', 5, first, 'root', false), fork: undefined, name: 'my own fork' } as HarnessSession,
    );
    await writeState(state);
    const sessions = (await readState()).sessions;
    const byId = new Map(sessions.map((session) => [session.id, session]));
    expect(byId.get('empty')!.foldedInto).toBe('main');
    expect(byId.get('side')!.foldedInto).toBe('main');
    expect(byId.get('main')!.messages!.map((message) => message.content)).toEqual(['one', '1', 'side', 's', 'main', 'm']);
    // A fork from before the marker, told by its own name on the same provider.
    expect(byId.get('named')).toMatchObject({ fork: true });
    expect(byId.get('named')!.foldedInto).toBeUndefined();
  });

  it('leaves a branch with something queued, or a turn still running, listed', async () => {
    const first = [user('one'), said('1')];
    const state = await readState();
    state.sessions.push(
      { ...chat('q', 'claude', 3, first), conversationId: 'q', queuedTurns: [{ id: 'x', text: 'later', submittedAt: at(3) }] },
      { ...chat('qa', 'codex', 4, [...first, user('three'), said('3')], 'q'), conversationId: 'q' },
    );
    await writeState(state);
    const sessions = (await readState()).sessions;
    expect(sessions.filter((session) => session.foldedInto)).toEqual([]);
  });
});
