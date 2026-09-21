import { describe, expect, it } from 'vitest';
import { nativeResponseUpdate } from './adapters';
import { nativeSessionIds } from '../protocol/session-ids';
import { codex } from '../protocol/vendor-fixtures.vitest';
import type { AiLocalHarnessDefinition } from '../types';

describe('native harness response streams', () => {
  const harness = (command: string): AiLocalHarnessDefinition => ({ ...codex, command, displayName: command });

  it('extracts documented Antigravity deltas and conversation ids', () => {
    const line = JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c3b66b04-872b-4fbe-a3a4-058a026ef20a', step_type: 'agent_response', text_delta: 'chunk' } });
    expect(nativeResponseUpdate(harness('antigravity'), line)).toEqual({ text: 'chunk', mode: 'append' });
    expect([...nativeSessionIds(line, 'json-lines')]).toContain('c3b66b04-872b-4fbe-a3a4-058a026ef20a');
  });

  it('prioritizes explicit thread identities over nested item ids', () => {
    const output = [
      JSON.stringify({ type: 'item.completed', item: { id: 'item-first', type: 'reasoning' } }),
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-source' }),
    ].join('\n');
    expect([...nativeSessionIds(output, 'json-lines')][0]).toBe('thread-source');
  });

  it('extracts Claude/Qwen stream events, Cursor deltas, and Cline snapshots', () => {
    const streamEvent = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } } });
    expect(nativeResponseUpdate(harness('claude'), streamEvent)).toEqual({ text: 'A', mode: 'append' });
    expect(nativeResponseUpdate(harness('qwen'), streamEvent)).toEqual({ text: 'A', mode: 'append' });
    expect(nativeResponseUpdate(harness('cursor'), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'C' }] } })))
      .toEqual({ text: 'C', mode: 'append' });
    expect(nativeResponseUpdate(harness('cline'), JSON.stringify({ type: 'say', text: 'Current', partial: true })))
      .toEqual({ text: 'Current', mode: 'replace' });
    expect(nativeResponseUpdate(harness('pi'), JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'D' } })))
      .toEqual({ text: 'D', mode: 'append' });
    expect(nativeResponseUpdate(harness('goose'), JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'E' }] } })))
      .toEqual({ text: 'E', mode: 'append' });
    const openCodeText = JSON.stringify({ type: 'text', part: { text: 'F' } });
    expect(nativeResponseUpdate(harness('opencode'), openCodeText)).toEqual({ text: 'F', mode: 'append' });
    expect(nativeResponseUpdate(harness('kilo'), openCodeText)).toEqual({ text: 'F', mode: 'append' });
  });

  it('shows Codex agent messages as they arrive without rendering tool JSON as response text', () => {
    expect(nativeResponseUpdate(harness('codex'), JSON.stringify({
      type: 'item.completed', item: { type: 'agent_message', text: 'I am checking that now.' },
    }))).toEqual({ text: 'I am checking that now.\n\n', mode: 'append' });
    expect(nativeResponseUpdate(harness('codex'), JSON.stringify({
      type: 'item.completed', item: { type: 'mcp_tool_call', name: 'search', arguments: { query: 'test' } },
    }))).toBeUndefined();
  });
});

