/** Standard section 4/12: thinking is a row with a stable id, so a settled
 * thought can be keyed and a streamed one replaces itself. Every family whose
 * stream carries reasoning is held to it. Records are the shapes each vendor's
 * own docs/parsers describe (Pi json.md, opencode run's `reasoning` event,
 * Cursor's `thinking` deltas, Goose's `thinking` content part, Codex items). */
import { describe, expect, it } from 'vitest';
import { createStreamState, parseHarnessLine } from './adapters.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

const family = (parser: string, command = parser) => ({ command, parser, turn: { output: 'json-lines' } }) as unknown as AiLocalHarnessDefinition;

function thoughts(harness: AiLocalHarnessDefinition, records: Record<string, unknown>[]) {
  const state = createStreamState();
  return records.flatMap((record) => parseHarnessLine(harness, JSON.stringify(record), state).activities ?? [])
    .filter((event) => event.kind === 'thinking').map((event) => ({ id: event.id, label: event.label }));
}

describe('thinking has one stable id per thought', () => {
  it('Pi: the frames of one thought share an id, the next thought has another', () => {
    const update = (event: Record<string, unknown>) => ({ type: 'message_update', assistantMessageEvent: event });
    const partial = (thinking: string) => ({ content: [{ type: 'thinking', thinking }] });
    const out = thoughts(family('pi-json', 'pi'), [
      update({ type: 'thinking_start', contentIndex: 0, partial: partial('') }),
      update({ type: 'thinking_delta', contentIndex: 0, delta: 'Check', partial: partial('Check') }),
      update({ type: 'thinking_delta', contentIndex: 0, delta: ' the file', partial: partial('Check the file') }),
      update({ type: 'thinking_end', contentIndex: 0, content: 'Check the file', partial: partial('Check the file') }),
      update({ type: 'thinking_start', contentIndex: 0, partial: partial('') }),
      update({ type: 'thinking_delta', contentIndex: 0, delta: 'Second', partial: partial('Second') }),
    ]);
    expect(out.map((event) => event.id)).toEqual(['thinking:pi-1', 'thinking:pi-1', 'thinking:pi-1', 'thinking:pi-2']);
    expect(out[2]!.label).toBe('Check the file');
  });

  it('Cursor: fragments are joined into one growing thought until it completes', () => {
    const out = thoughts(family('cursor-stream-json', 'cursor'), [
      { type: 'thinking', subtype: 'delta', text: 'Look at ' },
      { type: 'thinking', subtype: 'delta', text: 'the repo' },
      { type: 'thinking', subtype: 'completed' },
      { type: 'thinking', subtype: 'delta', text: 'Now edit' },
    ]);
    expect(out).toEqual([
      { id: 'thinking:cursor-1', label: 'Look at' },
      { id: 'thinking:cursor-1', label: 'Look at the repo' },
      { id: 'thinking:cursor-2', label: 'Now edit' },
    ]);
  });

  it('opencode / Kilo: the reasoning part id', () => {
    const out = thoughts(family('opencode-json', 'opencode'), [{ type: 'reasoning', part: { id: 'prt_1', type: 'reasoning', text: 'Weigh the options' } }]);
    expect(out).toEqual([{ id: 'thinking:prt_1', label: 'Weigh the options' }]);
  });

  it('Goose: its message id and the part, not none', () => {
    const out = thoughts(family('goose'), [{ type: 'message', message: { id: 'msg-7', role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan it' }] } }]);
    expect(out).toEqual([{ id: 'thinking:msg-7:0', label: 'Plan it' }]);
  });

  it('Codex exec items: the reasoning item id, as the app-server keys it', () => {
    const out = thoughts(family('codex-items', 'codex'), [{ type: 'item.completed', item: { id: 'rs_1', type: 'reasoning', summary: ['Reading the diff'] } }]);
    expect(out).toEqual([{ id: 'rs_1', label: 'Reading the diff' }]);
  });
});
