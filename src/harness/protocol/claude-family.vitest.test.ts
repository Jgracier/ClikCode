/** Every harness that DECLARES the Claude stream is read as one, not just the
 * two that happen to be named claude and qwen. */
import { describe, expect, it } from 'vitest';
import { nativeTurnResult } from './turn-result.js';
import { parseNativeActivityEventsFromValue } from './activity-events.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

const harness = (command: string): AiLocalHarnessDefinition => ({
  command, displayName: command, parser: 'claude-stream-json',
  turn: { output: 'json-lines', responseFields: ['result'] },
} as unknown as AiLocalHarnessDefinition);

/** A two-step turn as Claude-shaped CLIs write it: words, a tool call, more
 * words -- and a `result` holding only the LAST text block. */
const records = [
  { type: 'system', subtype: 'init', session_id: 's' },
  { type: 'assistant', message: { content: [{ type: 'text', text: "I'm checking the workspace first." }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'The final commit is live.' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'The final commit is live.' },
];
const stdout = records.map((record) => JSON.stringify(record)).join('\n');

describe('harnesses that declare the Claude stream', () => {
  for (const command of ['claude', 'grok', 'gemini', 'amp', 'qwen']) {
    it(`${command}: keeps every text block, not just the last`, () => {
      const text = nativeTurnResult(harness(command), stdout).text;
      expect(text).toContain("I'm checking the workspace first.");
      expect(text).toContain('The final commit is live.');
    });

    it(`${command}: reads its tool calls as tool rows`, () => {
      const events = parseNativeActivityEventsFromValue(harness(command), records[2]);
      expect(events.some((event) => event.kind === 'tool-start')).toBe(true);
    });
  }
});
