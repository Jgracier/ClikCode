import { describe, expect, it } from 'vitest';
import { claudeTypedRequest, mayHoldClaudeRequest } from './claude-entry.js';

// Entries exactly as Claude Code 2.1.319 writes them.
const typed = { type: 'user', isSidechain: false, timestamp: '2026-11-13T19:10:11.736Z', message: { role: 'user', content: 'clikcode must have this capability' } };
const classifierNote = { type: 'user', isSidechain: false, isMeta: true, turnCompanion: true, timestamp: '2026-11-13T19:20:20.000Z', message: { role: 'user', content: 'Your response above was stopped by a safety classifier — this is not a tool or API error.' } };
const midTurn = { type: 'attachment', isSidechain: false, timestamp: '2026-11-13T19:12:10.000Z', attachment: { type: 'queued_command', prompt: 'mobile i mean', commandMode: 'prompt', timestamp: '2026-11-13T19:12:09.749Z', hostsOwnTurn: true } };

describe('which entries of a Claude thread a person typed', () => {
  it('a request between turns, and one sent while a turn ran', () => {
    expect(claudeTypedRequest(typed)).toEqual({ text: 'clikcode must have this capability', at: '2026-11-13T19:10:11.736Z' });
    expect(claudeTypedRequest(midTurn)).toEqual({ text: 'mobile i mean', at: '2026-11-13T19:12:09.749Z' });
    expect(claudeTypedRequest({ ...typed, message: { content: [{ type: 'text', text: 'look at this' }, { type: 'image', source: {} }] } })?.text).toBe('look at this');
  });

  it('never what Claude Code wrote to its own model: it is not the person\'s message in the chat', () => {
    expect(claudeTypedRequest(classifierNote)).toBeUndefined();
    expect(claudeTypedRequest({ ...typed, isCompactSummary: true })).toBeUndefined();
    expect(claudeTypedRequest({ ...typed, isSidechain: true })).toBeUndefined();
    expect(claudeTypedRequest({ ...typed, origin: { kind: 'task-notification' } })).toBeUndefined();
    expect(claudeTypedRequest({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'out' }] } })).toBeUndefined();
    expect(claudeTypedRequest({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'x', commandMode: 'task-notification' } })).toBeUndefined();
    expect(claudeTypedRequest({ type: 'queue-operation' }), 'the queue\'s own bookkeeping of the same message').toBeUndefined();
    expect(claudeTypedRequest({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } })).toBeUndefined();
  });

  it('only lines that can hold one are parsed', () => {
    expect(mayHoldClaudeRequest(JSON.stringify(typed))).toBe(true);
    expect(mayHoldClaudeRequest(JSON.stringify(midTurn))).toBe(true);
    expect(mayHoldClaudeRequest(JSON.stringify({ type: 'assistant', message: {} }))).toBe(false);
  });
});
