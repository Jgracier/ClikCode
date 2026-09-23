/** Claude's stream-json carries each block TWICE, and three harnesses that
 *  speak it had no parser mapped.
 *
 * The screenshot that started this: on Grok, every paragraph printed twice,
 * bare-concatenated -- "…already-landed policy work.I'll pick up from the
 * in-progress retention run…". The cause was not the transcript. The parsers
 * table is keyed by COMMAND, so qwen and kilo had hand-written delegating
 * entries while Grok, Gemini and Amp -- all declaring `claude-stream-json` --
 * had none and fell through to genericParser, which appends the
 * content_block_delta AND then the completed assistant message.
 */
import { describe, expect, it } from 'vitest';
import { allLocalHarnesses } from '@clikcode/router/ai-local-harness';
import { nativeResponseUpdate } from './adapters';

const harnessFor = (command: string) => allLocalHarnesses().find((item) => item.command === command)!;

/** The exact record sequence a claude-stream-json harness emits for one block
 *  when run with --include-partial-messages: deltas, then the whole block
 *  again as a completed message. */
function streamOneBlock(command: string, session: string, text: string): string[] {
  const harness = harnessFor(command);
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: session }),
    ...text.split(' ').map((word, index) => JSON.stringify({
      type: 'stream_event', session_id: session,
      event: { type: 'content_block_delta', delta: { text: index === 0 ? word : ` ${word}` } },
    })),
    JSON.stringify({ type: 'assistant', session_id: session, message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  ];
  return lines.flatMap((line) => {
    const update = nativeResponseUpdate(harness, line);
    return update?.text ? [update.text] : [];
  });
}

describe('every harness that speaks claude-stream-json', () => {
  const family = allLocalHarnesses().filter((harness) => harness.parser === 'claude-stream-json');

  it('is more than just Claude, which is why the family must be mapped', () => {
    expect(family.map((harness) => harness.command).sort())
      .toEqual(['amp', 'claude', 'gemini', 'grok', 'qwen']);
  });

  it.each(family.map((harness) => harness.command))('prints each block exactly once on %s', (command) => {
    const text = 'I will pick up from the retention run.';
    const printed = streamOneBlock(command, `s-${command}`, text).join('');
    expect(printed).toBe(text);
    // The screenshot's signature: the block appearing a second time, joined
    // with no separator to the first.
    expect(printed).not.toContain('run.I will');
    expect(printed.match(/I will pick up/g)).toHaveLength(1);
  });

  it('still carries the text when a build sends no partial deltas at all', () => {
    // The other half of the sawDeltas guard: without deltas the completed
    // message is the only carrier, and dropping it would print nothing.
    const harness = harnessFor('grok');
    nativeResponseUpdate(harness, JSON.stringify({ type: 'system', subtype: 'init', session_id: 'no-deltas' }));
    const update = nativeResponseUpdate(harness, JSON.stringify({
      type: 'assistant', session_id: 'no-deltas',
      message: { role: 'assistant', content: [{ type: 'text', text: 'only the whole thing' }] },
    }));
    expect(update?.text).toBe('only the whole thing');
  });

  it('keeps a paragraph break between blocks split by a tool call', () => {
    const harness = harnessFor('grok');
    const session = 'two-blocks';
    const emit = (record: unknown) => nativeResponseUpdate(harness, JSON.stringify(record))?.text ?? '';
    emit({ type: 'system', subtype: 'init', session_id: session });
    let out = emit({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { text: 'Let me check.' } } });
    emit({ type: 'stream_event', session_id: session, event: { type: 'content_block_start', content_block: { type: 'text' } } });
    out += emit({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { text: 'Found it.' } } });
    // Joined bare these read "Let me check.Found it."
    expect(out).not.toBe('Let me check.Found it.');
    expect(out).toContain('Let me check.');
    expect(out).toContain('Found it.');
  });
});
