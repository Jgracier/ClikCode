/** What a structured CLI's stream says before a block completes: tool calls
 * as they are chosen, thoughts as they stream, and usage per message. The
 * fixture is a real Claude Code 2.1.285 run with --include-partial-messages
 * (haiku, one Read, then an answer), trimmed of the init record's tool list. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { reportStructuredLine } from './structured';
import { createStreamState } from './adapters';
import type { HarnessTurnObserver } from './turn-observer';
import type { HarnessActivityEvent } from '../prompter';
import type { TurnUsage } from '../protocol/turn-usage';

const fixture = readFileSync(new URL('../transport/native/fixtures/claude-partial-messages.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean);

function run(command: string, lines: readonly string[]) {
  const harness = localHarnessForCommand(command)!;
  const activities: HarnessActivityEvent[] = [];
  const usage: TurnUsage[] = [];
  let text = '';
  const observer: HarnessTurnObserver = {
    onActivity: (event) => activities.push(event),
    onUsage: (reading) => usage.push(reading),
    onResponseDelta: (delta, mode) => { text = mode === 'replace' ? delta : text + delta; },
  };
  const turn = createStreamState();
  for (const line of lines) reportStructuredLine(harness, line, observer, turn);
  // What vendor-turn.ts keeps: each reading's fields replace the last's.
  const merged = usage.reduce<TurnUsage>((sum, reading) => ({ ...sum, ...reading }), {});
  return { activities, usage, merged, text };
}

describe('a Claude tool call on the partial-message stream', () => {
  it('starts its row when the model chooses the tool, then names what it reads', () => {
    const { activities } = run('claude', fixture);
    const read = activities.filter((event) => event.id === 'toolu_01P3yToYVn99Zmahra7QxGUU');
    // content_block_start: the name alone, before any argument has streamed.
    expect(read[0]).toMatchObject({ kind: 'tool-start', label: 'Read' });
    const firstDelta = fixture.findIndex((line) => line.includes('input_json_delta'));
    const startLine = fixture.findIndex((line) => line.includes('"content_block_start"') && line.includes('tool_use'));
    expect(startLine).toBeLessThan(firstDelta);
    // Arguments complete: the same row, now with its path -- then settled.
    const starts = read.filter((event) => event.kind === 'tool-start');
    expect(starts.at(-1)).toMatchObject({ label: 'Read /var/tmp/cc-fix-B-probe/note.txt' });
    expect(read.at(-1)).toMatchObject({ kind: 'tool-done' });
  });

  it('still answers once, however many records carry the text', () => {
    expect(run('claude', fixture).text).toBe('The file is a simple greeting message from a probe file.');
  });
});

describe('Claude usage as it streams', () => {
  it('reports each message as it starts, summed across the turn\'s messages', () => {
    const { usage } = run('claude', fixture);
    // message_start of the first call: its input and caches, 3 tokens out.
    expect(usage[0]).toMatchObject({ input: 10, cacheRead: 13796, cacheWrite: 9418, output: 3 });
    // The second call's closing delta: both messages, not the last alone.
    const beforeResult = usage.at(-2)!;
    expect(beforeResult).toMatchObject({ input: 18, output: 164, cacheRead: 37010, cacheWrite: 9580, reasoning: 75 });
    // Where the context stands after the second call: all it read, plus its answer.
    expect(beforeResult.contextUsed).toBe(8 + 23214 + 162 + 60);
  });

  it('takes the vendor\'s own totals, cost, window and reason from the result', () => {
    const { usage, merged } = run('claude', fixture);
    expect(usage.at(-1)).toMatchObject({
      input: 18, output: 164, cacheRead: 37010, cacheWrite: 9580, reasoning: 75,
      costUsd: 0.023698999999999998, contextWindow: 200000, stopReason: 'completed',
    });
    // The live context position survives the result, which does not carry one.
    expect(merged.contextUsed).toBe(23444);
  });

  it('says when the answer was cut off, and when the turn ran out of turns', () => {
    const result = (fields: Record<string, unknown>) => JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 2 }, ...fields });
    expect(run('claude', [result({ subtype: 'success', stop_reason: 'max_tokens' })]).merged.stopReason).toBe('max-tokens');
    expect(run('claude', [result({ subtype: 'error_max_turns', is_error: true, stop_reason: 'tool_use' })]).merged.stopReason).toBe('max-turns');
    expect(run('claude', [result({ subtype: 'success', stop_reason: 'refusal' })]).merged.stopReason).toBe('refusal');
  });
});

describe('Claude thinking as it streams', () => {
  const event = (inner: Record<string, unknown>) => JSON.stringify({ type: 'stream_event', event: inner, parent_tool_use_id: null });
  const lines = [
    event({ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 5 } } }),
    event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The user wants' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' the file read.' } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'The user wants the file read.' }] } }),
  ];

  it('is one thought that grows, not one per fragment', () => {
    const thoughts = run('claude', lines).activities.filter((item) => item.kind === 'thinking');
    expect(thoughts.map((item) => item.label)).toEqual(['thinking', 'The user wants', 'The user wants the file read.', 'The user wants the file read.']);
    // One id throughout, so every consumer replaces the row it already has.
    expect(new Set(thoughts.map((item) => item.id))).toEqual(new Set(['thinking:msg_1']));
  });
});

describe('Pi tool calls', () => {
  it('pair by the vendor\'s own call id, labelled by their arguments', () => {
    const { activities } = run('pi', [
      JSON.stringify({ type: 'tool_execution_start', toolCallId: 'call_a', toolName: 'read', args: { path: 'a.txt' } }),
      JSON.stringify({ type: 'tool_execution_start', toolCallId: 'call_b', toolName: 'read', args: { path: 'b.txt' } }),
      JSON.stringify({ type: 'tool_execution_end', toolCallId: 'call_b', toolName: 'read', result: {}, isError: false }),
      JSON.stringify({ type: 'tool_execution_end', toolCallId: 'call_a', toolName: 'read', result: {}, isError: true }),
    ]);
    expect(activities).toMatchObject([
      { kind: 'tool-start', id: 'call_a', label: 'Read a.txt' },
      { kind: 'tool-start', id: 'call_b', label: 'Read b.txt' },
      { kind: 'tool-done', id: 'call_b' },
      { kind: 'tool-error', id: 'call_a' },
    ]);
  });

  it('without ids, each call gets its own, and a completion settles the oldest', () => {
    const { activities } = run('pi', [
      JSON.stringify({ type: 'tool_execution_start', toolName: 'bash' }),
      JSON.stringify({ type: 'tool_execution_start', toolName: 'bash' }),
      JSON.stringify({ type: 'tool_execution_end', toolName: 'bash' }),
      JSON.stringify({ type: 'tool_execution_end', toolName: 'bash' }),
    ]);
    expect(activities.map((event) => `${event.kind} ${event.id}`)).toEqual([
      'tool-start call-1', 'tool-start call-2', 'tool-done call-1', 'tool-done call-2',
    ]);
  });

  it('reports each finished message\'s usage and cost, summed', () => {
    const message = (input: number, output: number, cost: number, stopReason: string) => JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', stopReason, usage: { input, output, cacheRead: 100, cacheWrite: 0, totalTokens: input + output + 100, cost: { total: cost } } },
    });
    const { merged } = run('pi', [message(10, 5, 0.01, 'toolUse'), message(20, 7, 0.02, 'length')]);
    expect(merged).toMatchObject({ input: 30, output: 12, cacheRead: 200, costUsd: 0.03, contextUsed: 127, stopReason: 'max-tokens' });
  });
});

describe('Cursor\'s repeated segment', () => {
  const delta = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp_ms: 1 });

  it('drops the flush Cursor writes before a retry, which is shaped like a delta', () => {
    // cursor-agent 2026.09.10: before a `retry` record it flushes the segment
    // with a timestamp and no model_call_id -- exactly a delta's shape.
    expect(run('cursor', [delta('Hel'), delta('lo'), delta('Hello'), JSON.stringify({ type: 'retry', subtype: 'starting' })]).text).toBe('Hello');
  });

  it('keeps a model that really says the same thing twice', () => {
    expect(run('cursor', [delta('ha'), delta('ha'), delta('!')]).text).toBe('haha!');
    expect(run('cursor', [delta('Checking the long output of that command now.'), delta('Checking the long output of that command now.'), delta(' Done.')]).text)
      .toBe('Checking the long output of that command now.Checking the long output of that command now. Done.');
  });
});
