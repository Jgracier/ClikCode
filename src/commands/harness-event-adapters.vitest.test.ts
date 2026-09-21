import { describe, expect, it } from 'vitest';
import { AI_LOCAL_HARNESSES } from '@clikdeploy/clikrouter/ai-local-harness';
import { nativeResponseUpdate } from './harness-event-adapters.js';
import { harnessTurnTransport } from './harness-transport.js';
import type { AiLocalHarnessDefinition } from './types.js';

const harness = (command: string, output: 'text' | 'json' | 'json-lines' = 'json-lines'): AiLocalHarnessDefinition => ({
  command, provider: command, displayName: command, surface: 'terminal', localAuth: ['vendor-cli'], binary: command,
  turn: { startArgv: [], output },
});

const update = (command: string, value: unknown, output: 'text' | 'json' | 'json-lines' = 'json-lines') =>
  nativeResponseUpdate(harness(command, output), typeof value === 'string' ? value : JSON.stringify(value));

describe('vendor response parsers', () => {
  it('keeps each declared vendor shape mapped to its own stream', () => {
    expect(update('claude', { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'hi' } } }))
      .toEqual({ text: 'hi', mode: 'append' });
    expect(update('cline', { type: 'say', text: 'partial' })).toEqual({ text: 'partial', mode: 'replace' });
    expect(update('opencode', { type: 'text', part: { text: 'chunk' } })).toEqual({ text: 'chunk', mode: 'append' });
  });

  it('ignores malformed lines instead of surfacing them as answer text', () => {
    expect(update('claude', 'not json at all')).toBeUndefined();
    expect(update('claude', { type: 'stream_event', event: { type: 'content_block_delta', delta: {} } })).toBeUndefined();
  });
});

describe('generic streaming fallback', () => {
  // `kiro` and `command` are json-lines harnesses with no vendor parser. They
  // previously streamed nothing at all, so a whole turn showed a blank region
  // and the answer appeared only once the process exited.
  it('streams Claude-style stream-json from a harness with no vendor parser', () => {
    expect(update('kiro', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } }))
      .toEqual({ text: 'partial', mode: 'append' });
    expect(update('kiro', { type: 'result', result: 'final answer' }))
      .toEqual({ text: 'final answer', mode: 'replace' });
  });

  it('accepts a single terminal result envelope', () => {
    expect(update('command', { type: 'result', result: 'done', session_id: 'x' }))
      .toEqual({ text: 'done', mode: 'replace' });
    expect(update('command', { type: 'turn.completed', response: 'done' }))
      .toEqual({ text: 'done', mode: 'replace' });
  });

  it('reads deltas, completed agent items, and bare assistant text', () => {
    expect(update('kiro', { type: 'content_block_delta', delta: { text: 'tok' } }))
      .toEqual({ text: 'tok', mode: 'append' });
    expect(update('kiro', { type: 'item.completed', item: { type: 'agent_message', text: 'said' } }))
      .toEqual({ text: 'said\n\n', mode: 'append' });
    expect(update('kiro', { type: 'text', text: 'plain' })).toEqual({ text: 'plain', mode: 'append' });
  });

  // The checklist requires that structured output never mistakes tool or user
  // content for the answer. The generic path is the easiest place to get this
  // wrong, because it matches on shape rather than on a known vendor.
  it('never surfaces tool, user, system, or error content', () => {
    expect(update('kiro', { type: 'tool_use', name: 'bash', input: { text: 'rm -rf /' } })).toBeUndefined();
    expect(update('kiro', { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'my prompt' }] } })).toBeUndefined();
    expect(update('kiro', { type: 'system', text: 'booting' })).toBeUndefined();
    expect(update('kiro', { type: 'error', text: 'boom' })).toBeUndefined();
    expect(update('kiro', { type: 'tool_result', content: [{ type: 'text', text: 'file contents' }] })).toBeUndefined();
    expect(update('kiro', { type: 'message', role: 'user', content: 'echo' })).toBeUndefined();
  });

  it('yields nothing for an unrecognized shape rather than guessing', () => {
    expect(update('kiro', { type: 'heartbeat', seq: 3 })).toBeUndefined();
    expect(update('kiro', { unknown: true })).toBeUndefined();
    expect(update('kiro', 'still not json')).toBeUndefined();
  });
});

describe('plain-text harness streaming', () => {
  // A text harness prints the answer itself and nativeTurnResult returns that
  // same stdout, so echoing lines live cannot diverge from what is persisted.
  it('echoes each line so a long turn is not a blank screen', () => {
    expect(update('aider', 'thinking about it', 'text')).toEqual({ text: 'thinking about it\n', mode: 'append' });
    expect(update('crush', '{"looks":"like json"}', 'text')).toEqual({ text: '{"looks":"like json"}\n', mode: 'append' });
  });

  it('leaves a vendor-parsed harness on its own parser', () => {
    // cline declares json-lines; a text line must not be echoed verbatim.
    expect(update('cline', 'plain line')).toBeUndefined();
  });
});

/** One representative streaming line per vendor shape. This doubles as the
 * per-vendor parser fixture set: if a vendor changes its envelope, the mapping
 * below is where that shows up as a failure rather than as a silent blank
 * region during a live turn. */
const VENDOR_SAMPLES: Readonly<Record<string, unknown>> = {
  claude: { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'hi' } } },
  qwen: { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'hi' } } },
  cursor: { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
  cline: { type: 'say', text: 'hi' },
  pi: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } },
  goose: { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
  opencode: { type: 'text', part: { text: 'hi' } },
  kilo: { type: 'text', part: { text: 'hi' } },
  antigravity: { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'hi' } },
};

/** The shape a harness with no vendor entry is expected to fall back to. */
const GENERIC_SAMPLE = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } };

describe('catalog streaming coverage', () => {
  it('gives every selectable terminal harness a live response path', () => {
    const silent = AI_LOCAL_HARNESSES.filter((entry: AiLocalHarnessDefinition) => {
      if (entry.surface === 'editor-extension' || !entry.turn) return false;
      // ACP and the codex app-server stream through their own transports and
      // never reach this adapter.
      const transport = harnessTurnTransport(entry);
      if (transport === 'acp' || transport === 'codex-app-server') return false;
      const sample = entry.turn.output === 'text'
        ? 'a line of answer'
        : JSON.stringify(VENDOR_SAMPLES[entry.command] ?? GENERIC_SAMPLE);
      return !nativeResponseUpdate(entry, sample);
    }).map((entry: AiLocalHarnessDefinition) => entry.command);
    expect(silent).toEqual([]);
  });

  it('matches every vendor fixture to the harness that declares it', () => {
    for (const [command, sample] of Object.entries(VENDOR_SAMPLES)) {
      const entry = AI_LOCAL_HARNESSES.find((item: AiLocalHarnessDefinition) => item.command === command);
      expect(entry, `${command} is missing from the catalog`).toBeDefined();
      expect(nativeResponseUpdate(entry!, JSON.stringify(sample)), `${command} stopped parsing its own shape`)
        .toMatchObject({ text: expect.stringContaining('hi') });
    }
  });
});
