/** The canonical record: a conversation read back as one list of turns,
 * each with what produced it. */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { HarnessSession, TranscriptMessage } from './model.js';
import { canonicalRecord } from './canonical.js';
import { finishPendingTurn } from '../turn/checkpoint.js';

const now = '2026-10-04T00:00:00.000Z';

function session(fields: Partial<HarnessSession>): HarnessSession {
  return {
    id: randomUUID(), route: 'local', accountId: null, provider: 'anthropic', model: 'opus', effort: 'high',
createdAt: now, updatedAt: now, status: 'active', workspace: '/w', ...fields,
  };
}

const user = (content: string, attachments?: string[]): TranscriptMessage => ({ role: 'user', content, ...(attachments ? { attachments } : {}) });
const said = (content: string, activities?: TranscriptMessage['activities']): TranscriptMessage => ({ role: 'assistant', content, ...(activities ? { activities } : {}) });

const claude = { harness: 'claude', route: 'local' as const, provider: 'anthropic', model: 'opus' };
const by = (origin: TranscriptMessage['origin'], messages: TranscriptMessage[]): TranscriptMessage[] => messages.map((message) => ({ ...message, origin }));

/** root (Claude, 2 turns) -> moved to Codex in place (+2 turns) -> a fork of
 * its first turn only, on OpenCode (+1 turn). */
function chain() {
  const root = session({
    nativeHarness: 'claude', model: 'opus',
    messages: [
      user('read the parser', ['/w/notes.md']), said('It reads tokens.', [
        { responseOffset: 0, event: { kind: 'tool-done', label: 'Read src/parser.ts', category: 'read', output: ['export function parse() {}'], call: { name: 'Read', input: { file_path: 'src/parser.ts' } } } },
      ]),
      user('rename it'), said('Renamed it to Reader. Tests pass.', [
        { responseOffset: 0, event: { kind: 'tool-done', label: 'Edit src/parser.ts', category: 'edit', diff: [{ path: 'src/parser.ts', lines: [], additions: 1, removals: 1 }] } },
        { responseOffset: 12, event: { kind: 'tool-error', label: '$ npm test', category: 'run', output: ['FAIL a.test.ts'], exitCode: 1 } },
      ]),
    ],
  });
  const child = session({
    id: root.id, nativeHarness: 'codex', provider: 'openai', model: 'gpt-5',
    messages: [...by(claude, root.messages!), user('now the docs'), said('Docs updated.', [
      { responseOffset: 0, event: { kind: 'tool-done', label: 'Edit docs/README.md', category: 'edit' } },
    ])],
  });
  const fork = session({
    nativeHarness: 'opencode', provider: 'opencode', model: 'big-pickle', parentSessionId: child.id, conversationId: root.id,
    messages: [...by(claude, root.messages!.slice(0, 2)), user('try another name'), said('Called it Lexer.')],
  });
  return { root, child, fork };
}

describe('canonicalRecord', () => {
  it('reads the conversation in order, one numbering, each turn with its producer', () => {
    const { root, child } = chain();
    const record = canonicalRecord(child);
    expect(record.turns.map((turn) => [turn.index, turn.user, turn.origin.harness, turn.origin.model])).toEqual([
      [0, 'read the parser', 'claude', 'opus'],
      [1, 'rename it', 'claude', 'opus'],
      [2, 'now the docs', 'codex', 'gpt-5'],
    ]);
    expect(record.conversationId).toBe(root.id);
  });

  it('keeps every tool call, including on turns that wrote text, with category, name, args, output and status', () => {
    const { root, child } = chain();
    const [first, second] = canonicalRecord(child).turns;
    expect(first!.tools).toEqual([expect.objectContaining({
      category: 'read', name: 'Read', input: { file_path: 'src/parser.ts' }, target: 'src/parser.ts', status: 'done', output: ['export function parse() {}'],
    })]);
    expect(second!.tools.map((call) => [call.name, call.target, call.status, call.exitCode])).toEqual([
      ['Edit', 'src/parser.ts', 'done', undefined], ['shell', 'npm test', 'failed', 1],
    ]);
    // Text and calls in the order they happened.
    expect(second!.parts.map((part) => part.type)).toEqual(['tool', 'text', 'tool', 'text']);
    expect(second!.assistant).toBe('Renamed it to Reader. Tests pass.');
  });

  it('collects touched files and attachments across the conversation', () => {
    const { root, child } = chain();
    const record = canonicalRecord({ ...child, attachments: ['/w/next.png'] });
    expect(record.touchedFiles).toEqual(['src/parser.ts', 'docs/README.md']);
    expect(record.turns[0]!.attachments).toEqual(['/w/notes.md']);
    expect(record.attachments).toEqual(['/w/notes.md']);
    expect(record.pendingAttachments).toEqual(['/w/next.png']);
  });

  it('keeps who answered on what a fork copied', () => {
    const { fork } = chain();
    const record = canonicalRecord(fork);
    expect(record.turns.map((turn) => [turn.user, turn.origin.harness])).toEqual([
      ['read the parser', 'claude'], ['try another name', 'opencode'],
    ]);
  });

  it('stamps a committed turn with the harness and model that ran it', () => {
    const { root } = chain();
    const live = { ...root, reported: { at: now, model: 'opus-4' }, pendingTurn: { prompt: 'go', response: 'went', startedAt: now, updatedAt: now, outputStarted: true } };
    finishPendingTurn(live, undefined, now);
    expect(live.messages!.at(-1)).toMatchObject({ role: 'assistant', content: 'went', origin: { harness: 'claude', route: 'local', provider: 'anthropic', model: 'opus-4' } });
  });

  it('marks a turn still in the journal interrupted, with the files it had started changing', () => {
    const { root } = chain();
    const live = {
      ...root,
      pendingTurn: {
        prompt: 'split the file', attachments: ['/w/spec.md'], response: 'Moving the lexer out', startedAt: now, updatedAt: now, outputStarted: true,
        touchedFiles: ['src/lexer.ts'],
      },
    } as HarnessSession;
    const last = canonicalRecord(live).turns.at(-1)!;
    expect(last).toMatchObject({ user: 'split the file', attachments: ['/w/spec.md'], assistant: 'Moving the lexer out', interrupted: true, touchedFiles: ['src/lexer.ts'] });
  });

  it('carries the stored plan and its open todos', () => {
    const { root } = chain();
    const record = canonicalRecord({ ...root, plan: { at: now, entries: [{ content: 'rename', status: 'completed' }, { content: 'docs', status: 'in_progress' }] } });
    expect(record.openTodos).toEqual([{ content: 'docs', status: 'in_progress' }]);
  });

});
