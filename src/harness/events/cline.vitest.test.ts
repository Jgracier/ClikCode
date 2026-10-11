/** Cline's `--json` stream (a ClineMessage per line: `type` say|ask, the
 * `say`/`ask` kind, `text`, `ts`, `partial`). Crafted from Cline's own message
 * vocabulary (ClineSay: tool, command, command_output, reasoning,
 * completion_result, use_mcp_server, mcp_server_response); there is no
 * recorded run because the CLI always runs over ACP here (catalog-consistency)
 * and a signed-out CLI emits no tool turn. */
import { describe, expect, it } from 'vitest';
import { createStreamState, parseHarnessLine } from './adapters.js';
import type { AiLocalHarnessDefinition } from '../definition.js';
import type { HarnessActivityEvent } from '../prompter.js';

const cline = { command: 'cline', parser: 'cline-json', turn: { output: 'json-lines' } } as unknown as AiLocalHarnessDefinition;

function run(records: Record<string, unknown>[]): { events: HarnessActivityEvent[]; text: string[] } {
  const state = createStreamState();
  const events: HarnessActivityEvent[] = [];
  const text: string[] = [];
  for (const record of records) {
    const parsed = parseHarnessLine(cline, JSON.stringify(record), state);
    events.push(...(parsed.activities ?? []));
    if (parsed.response) text.push(parsed.response.text);
  }
  return { events, text };
}

const tool = (ts: number, payload: Record<string, unknown>, partial = false) =>
  ({ type: 'say', say: 'tool', ts, partial, text: JSON.stringify(payload) });

describe('Cline CLI tool rows', () => {
  it('starts a read once and settles it when the next message arrives, under a stable id', () => {
    const { events, text } = run([
      tool(10, { tool: 'readFile', path: 'src/a.ts' }, true),
      tool(10, { tool: 'readFile', path: 'src/a.ts' }),
      { type: 'say', say: 'text', ts: 11, text: 'It exports one function.' },
    ]);
    expect(events.map((event) => [event.kind, event.id, event.label, event.category])).toEqual([
      ['tool-start', 'cline-10', 'Read src/a.ts', 'read'],
      ['tool-done', 'cline-10', 'Read src/a.ts', 'read'],
    ]);
    // A tool payload is never the answer.
    expect(text).toEqual(['It exports one function.']);
  });

  it('shows a command with its output as progress, then done', () => {
    const { events } = run([
      { type: 'say', say: 'command', ts: 20, text: 'npm test' },
      { type: 'say', say: 'command_output', ts: 21, text: 'PASS a\nPASS b' },
      { type: 'say', say: 'completion_result', ts: 22, text: 'All pass.' },
    ]);
    expect(events.map((event) => [event.kind, event.id, event.output])).toEqual([
      ['tool-start', 'cline-20', undefined],
      ['tool-start', 'cline-20', ['PASS a', 'PASS b']],
      // The settled row carries what the command printed.
      ['tool-done', 'cline-20', ['PASS a', 'PASS b']],
    ]);
    expect(events[0]).toMatchObject({ label: '$ npm test', category: 'run' });
  });

  it('closes an open call as an error when Cline reports one', () => {
    const { events } = run([
      tool(30, { tool: 'editedExistingFile', path: 'x.ts', diff: '...' }),
      { type: 'say', say: 'error', ts: 31, text: 'diff did not apply' },
    ]);
    expect(events.map((event) => [event.kind, event.id])).toEqual([['tool-start', 'cline-30'], ['tool-error', 'cline-30']]);
    expect(events[0]).toMatchObject({ category: 'edit' });
  });

  it('keeps reasoning as a thought with one id per message', () => {
    const { events } = run([
      { type: 'say', say: 'reasoning', ts: 40, partial: true, text: 'Let me' },
      { type: 'say', say: 'reasoning', ts: 40, text: 'Let me look at the config' },
    ]);
    expect(events.map((event) => [event.kind, event.id])).toEqual([['thinking', 'thinking:cline-40'], ['thinking', 'thinking:cline-40']]);
  });
});
