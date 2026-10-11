import { describe, expect, it } from 'vitest';
import { AI_LOCAL_HARNESSES } from '../../../packages/clikrouter/src/ai-local-harness.js';
import { createStreamState } from './adapters.js';
import { reportStructuredLine } from './structured.js';

// A turn is text, a tool, then more text. The answer must keep the break between the two: MEASURED
// 2026-10-11 through the harness matrix, pi's closing answer was saved glued to the sentence before its
// tools ("...now.Finished...") and then lost at the end of the turn. Every family goes through one rule.
const harness = (command: string) => AI_LOCAL_HARNESSES.find((entry) => entry.command === command)!;

function play(command: string, lines: unknown[]) {
  const definition = harness(command);
  const state = createStreamState();
  const text: string[] = [];
  const activities: Array<{ kind: string; label: string; id?: string }> = [];
  const observer = {
    onResponseDelta: (piece: string, mode: string) => { if (mode === 'append') text.push(piece); },
    onActivity: (event: { kind: string; label: string; id?: string }) => activities.push(event),
  };
  for (const line of lines) reportStructuredLine(definition as never, JSON.stringify(line), observer as never, state);
  return { answer: text.join(''), activities };
}

describe('text after a tool call is a new paragraph, in every family that builds its own update', () => {
  it('pi', () => {
    const { answer } = play('pi', [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Looking now.' } },
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } },
      { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Found it.' } },
    ]);
    expect(answer).toBe('Looking now.\n\nFound it.');
  });

  it('antigravity', () => {
    const { answer } = play('antigravity', [
      { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 100, state: 'ACTIVE', text_delta: 'Looking now.' } },
      { event: 'step_update', step_update: { step_type: 'tool', step_index: 1, state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls' } } } },
      { event: 'step_update', step_update: { step_type: 'tool', step_index: 1, state: 'DONE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls' } } } },
      { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 101, state: 'ACTIVE', text_delta: 'Found it.' } },
    ]);
    expect(answer).toBe('Looking now.\n\nFound it.');
  });

  it('does not break a paragraph that no tool interrupted, or double an existing break', () => {
    const plain = play('pi', [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'One ' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'sentence.' } },
    ]);
    expect(plain.answer).toBe('One sentence.');
    const already = play('pi', [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Before.' } },
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '\n\nAfter.' } },
    ]);
    expect(already.answer).toBe('Before.\n\nAfter.');
  });

  it("a sub-agent's own tool call does not break the parent's paragraph", () => {
    const { answer } = play('claude', [
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working' } } },
      { type: 'assistant', parent_tool_use_id: 'task1', message: { id: 'm', content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: '/a' } }] } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' on it.' } } },
    ]);
    expect(answer).toBe('Working on it.');
  });
});

describe("pi's JSON mode is delta-only (its docs/json.md): no `partial` on message_update", () => {
  it('reads the reasoning from the deltas, as one thought with one id', () => {
    const { activities } = play('pi', [
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '**Reading the parser**\n\n' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Tokens first.' } },
    ]);
    const thoughts = activities.filter((event) => event.kind === 'thinking');
    expect(thoughts.length).toBeGreaterThan(0);
    expect(new Set(thoughts.map((event) => event.id)).size).toBe(1);
    expect(thoughts.at(-1)!.label).toContain('Reading the parser');
    expect(thoughts.at(-1)!.label).toContain('Tokens first.');
  });

  it("pairs `toolcall_start` (id + toolName, no partial) with the execution that follows: one call, not two", () => {
    const { activities } = play('pi', [
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'call-9', toolName: 'bash' } },
      { type: 'tool_execution_start', toolCallId: 'call-9', toolName: 'bash', args: { command: 'echo hi' } },
      { type: 'tool_execution_end', toolCallId: 'call-9', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'hi' }] } },
    ]);
    const calls = activities.filter((event) => event.kind !== 'thinking');
    expect(new Set(calls.map((event) => event.id)).size).toBe(1);
    expect(calls.every((event) => event.id === 'call-9')).toBe(true);
    expect(calls.at(-1)!.kind).toBe('tool-done');
  });
});
