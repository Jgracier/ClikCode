/** Tables keyed by harness NAME must agree with what the catalog DECLARES
 * about each harness. Four bugs in one day came from a table that listed
 * `claude` and `qwen` by name while grok, gemini and amp declared the same
 * stream and were silently left out. These tests make that drift a failure
 * the moment a harness is added or its stream changes. */
import { describe, expect, it } from 'vitest';
import { AI_LOCAL_HARNESSES } from '@clikcode/router/ai-local-harness';
import { CLAUDE_TOOL_NAMES, HARNESS_TOOL_MAPPINGS } from './tools.js';
import { claudeShaped } from './json-lines.js';

const declaring = (parser: string) => AI_LOCAL_HARNESSES.filter((harness) => harness.parser === parser);

describe('what the catalog declares, every table honours', () => {
  it('names every Claude-stream harness\'s tools the Claude way', () => {
    const family = declaring('claude-stream-json');
    expect(family.length).toBeGreaterThan(1);
    for (const harness of family) expect(HARNESS_TOOL_MAPPINGS[harness.command]?.names, harness.command).toBe(CLAUDE_TOOL_NAMES);
  });

  it('reads every Claude-stream harness as Claude-shaped', () => {
    for (const harness of declaring('claude-stream-json')) expect(claudeShaped(harness), harness.command).toBe(true);
  });

  it('has a tool mapping for every harness in the catalog', () => {
    for (const harness of AI_LOCAL_HARNESSES) expect(HARNESS_TOOL_MAPPINGS[harness.command], harness.command).toBeDefined();
  });
});

describe('every stream format the catalog declares', () => {
  it('has a parser, or is one of the formats read generically on purpose', async () => {
    const { parsersByFamily } = await import('../events/adapters.js');
    // generic-json: the shape-matching reader IS its parser. text: no stream.
    // codex-items: codex always negotiates its app-server, never this path.
    const generic = new Set(['generic-json', 'text', 'codex-items']);
    const families = new Set(AI_LOCAL_HARNESSES.map((harness) => harness.parser).filter((parser): parser is string => Boolean(parser)));
    for (const family of families) {
      expect(generic.has(family) || family in parsersByFamily, family).toBe(true);
    }
  });
});

describe('Cline', () => {
  it('always runs over ACP, where its answer arrives as appended chunks', async () => {
    // Its `--json` records (`say`) REPLACE the displayed text -- right for
    // updates to one message, wrong across messages. That parser is only
    // reached if Cline falls back to its structured CLI, which it never does
    // while ACP is its stable, preferred transport. If that changes, this
    // fails, and the `say` shape has to be verified before it ships.
    const { harnessTurnTransport } = await import('../transport/select.js');
    const cline = AI_LOCAL_HARNESSES.find((harness) => harness.command === 'cline')!;
    expect(harnessTurnTransport(cline)).toBe('acp');
    expect(harnessTurnTransport(cline, true, { acpImages: true })).toBe('acp');
  });
});
