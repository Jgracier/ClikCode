/** Context profiles: how much the agent spends on context, per session.
 *
 * The same token costs very different amounts on different inference. On a
 * laptop CPU a model reads 50-100 prompt tokens a second in a 16-32K window,
 * so every token of guidance, schema or tool output is seconds of waiting and
 * a slice of a small window. On the Gateway, or a local model on a real GPU,
 * prompts are read at thousands of tokens a second, windows are 128K and up,
 * and (on the Gateway) cached input is billed at a fraction -- the prompt
 * prefix is byte-stable (context.ts), so what is spent once is mostly cached
 * after. There, spending more tokens to save a step is the right trade:
 * MCP schemas sent up front instead of a `load_mcp_tools` round trip, whole
 * files in one read instead of "continue at offset", more skills listed.
 *
 *   full     lean plus: MCP schemas eager up to a much higher budget, larger
 *            tool-output caps, more (and longer) skill descriptions.
 *   lean     the former local defaults, retained as the rollback profile.
 *   minimal  lean minus repeated tool guidance and bulky schemas:
 *            the system prompt's "Editing files" / "Shell" bullets that
 *            restate the tool descriptions, `additionalProperties:false` in
 *            the schemas sent (the loop still validates against the full
 *            schema), terser descriptions for tools small models rarely use,
 *            and fewer, shorter skill lines. On Ornith 1.5 35B at 16K,
 *            this passed 6/7 coding tasks twice versus lean's 5/7 three
 *            times. Shortening the remaining tool descriptions further
 *            caused a valid-tool-call failure, so they stay intact.
 *
 * Deliberately NOT in minimal:
 *   - Eliding old or superseded tool results before compaction. Rewriting an
 *     earlier item changes the prompt prefix, so everything after it is read
 *     again -- on a CPU that costs more than the tokens it saves, every time
 *     it happens. Compaction already does this, but rarely and all at once.
 *   - One `mcp_call` proxy in place of per-tool MCP schemas. MCP tools are
 *     already deferred behind `load_mcp_tools` here; a proxy would have the
 *     model write arguments for a schema it never saw, which is exactly
 *     where small models fail. Not trivially safe.
 *
 * The profile is decided once per turn from facts that do not change within
 * a session (the model's window and prompt speed), so every turn of a session
 * sends the same system prompt and tool list and the prefix cache holds. */

import type { ToolSpec } from './model-client.js';

export type ContextProfileName = 'minimal' | 'lean' | 'full';
export const CONTEXT_PROFILES: readonly ContextProfileName[] = ['minimal', 'lean', 'full'];

/** Forces a profile for every turn in this process, over a session's own
 * setting and the automatic choice: an evaluation must be able to pin each
 * profile and know every turn ran under it. */
export const CONTEXT_PROFILE_ENV = 'CLIKCODE_CONTEXT_PROFILE';

export interface ContextProfile {
  name: ContextProfileName;
  /** MCP schemas totalling more than this (tokens) are deferred behind
   * `load_mcp_tools` (mcp/deferred.ts). */
  mcpEagerSchemaTokens: number;
  /** Ceiling of one tool result, in bytes, before the window-based cap
   * (context.ts toolOutputCap) narrows it further. */
  toolOutputBytes: number;
  maxListedSkills: number;
  skillDescriptionChars: number;
  /** Keep the system prompt's "Editing files" and "Shell" sections. */
  toolUsageGuidance: boolean;
  /** Reshapes the tool specs sent to the model. Must be deterministic: the
   * specs are part of the cached prefix. */
  shapeSpecs(specs: readonly ToolSpec[]): ToolSpec[];
}

// ── thresholds ───────────────────────────────────────────────────────────────

/** Lean's MCP budget, as tuned for local models: below ~1,500 tokens a
 * listing of the servers costs about what their schemas do, so they are sent. */
const LEAN_MCP_EAGER_TOKENS = 1_500;

/** Full's MCP budget. The two servers measured on a developer machine came
 * to ~7,900 tokens; under this they go up front, which saves the loader round
 * trip AND the one cache break that loading causes (the tool list sits before
 * the conversation, so a newly loaded schema makes everything after it be
 * read again). 10K is still under 8% of a 128K window; beyond it -- a server
 * with a hundred tools -- deferring wins even when tokens are cheap. */
const FULL_MCP_EAGER_TOKENS = 10_000;

/** Lean's ceiling is the long-standing 30 KB (~7,500 tokens). */
const LEAN_TOOL_OUTPUT_BYTES = 30 * 1024;

/** Full's ceiling, ~16K tokens: most source files (500-1,500 lines at ~40
 * bytes) come back in one read instead of two or three "continue at offset"
 * reads, each of which is a whole extra step. The window cap (10% of the
 * window) still applies, so a 128K window gets ~51 KB. */
const FULL_TOOL_OUTPUT_BYTES = 64 * 1024;

/** Skills listed and description length. Lean's 20 x 150 chars is at most
 * ~850 tokens; full's 50 x 250 at most ~3,300, cached after the first step;
 * minimal's 10 x 80 at most ~250 -- a small model rarely picks a skill, and
 * an unlisted one is still found by name (skills.ts). */
const SKILLS = {
  minimal: { maxListedSkills: 10, skillDescriptionChars: 80 },
  lean: { maxListedSkills: 20, skillDescriptionChars: 150 },
  full: { maxListedSkills: 50, skillDescriptionChars: 250 },
} as const;

/** Windows at or below this get lean whatever the speed: full's larger tool
 * outputs (~16K tokens) and eager MCP schemas (~10K) would take most of a
 * 32K window by themselves and force early compaction. 32K is also the
 * largest window ClikCode Local gives a model on a typical laptop. */
export const LEAN_MAX_CONTEXT_WINDOW = 32_768;

/** Prompt reading slower than this gets lean. Measured prompt speeds are
 * bimodal: laptop CPUs read 50-100 tokens/s (the engine's floor for a usable
 * model is 50), while any discrete or Apple GPU reads several hundred to
 * thousands. 150 sits in the gap, so the exact value matters little; what
 * it separates is "an extra 8K-token tool result is about a minute" from
 * "it is a few seconds". */
export const LEAN_BELOW_PROMPT_PER_SECOND = 150;

// ── spec shaping ─────────────────────────────────────────────────────────────

/** Shorter descriptions, for minimal, of tools a small model rarely needs.
 * What a call must look like still comes from the schema; what is dropped is
 * advice on when and how to use the tool well. */
const TERSE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  task: 'Start a read-only research sub-agent. It sees none of this conversation: give it a self-contained prompt. Only its final answer comes back.',
  web_fetch: 'Fetch a public http(s) URL and return its content as text.',
  web_search: 'Search the web; returns titles, URLs and snippets.',
};

function withoutClosedObjects(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutClosedObjects);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' && value === false) continue;
    out[key] = withoutClosedObjects(value);
  }
  return out;
}

const unchanged = (specs: readonly ToolSpec[]): ToolSpec[] => [...specs];

/** Minimal: `additionalProperties:false` goes (~140 tokens over the built-in
 * tools). It cuts both ways -- llama.cpp can use it to constrain a small
 * model's arguments -- but the loop validates every call against the full
 * schema anyway and answers an extra argument with the schema, so a wrong
 * call costs a retry, not a wrong action. */
function minimalSpecs(specs: readonly ToolSpec[]): ToolSpec[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: TERSE_DESCRIPTIONS[spec.name] ?? spec.description,
    parameters: withoutClosedObjects(spec.parameters) as Record<string, unknown>,
  }));
}

export const PROFILES: Readonly<Record<ContextProfileName, ContextProfile>> = {
  minimal: {
    name: 'minimal', mcpEagerSchemaTokens: LEAN_MCP_EAGER_TOKENS, toolOutputBytes: LEAN_TOOL_OUTPUT_BYTES,
    ...SKILLS.minimal, toolUsageGuidance: false, shapeSpecs: minimalSpecs,
  },
  lean: {
    name: 'lean', mcpEagerSchemaTokens: LEAN_MCP_EAGER_TOKENS, toolOutputBytes: LEAN_TOOL_OUTPUT_BYTES,
    ...SKILLS.lean, toolUsageGuidance: true, shapeSpecs: unchanged,
  },
  full: {
    name: 'full', mcpEagerSchemaTokens: FULL_MCP_EAGER_TOKENS, toolOutputBytes: FULL_TOOL_OUTPUT_BYTES,
    ...SKILLS.full, toolUsageGuidance: true, shapeSpecs: unchanged,
  },
};

// ── selection ────────────────────────────────────────────────────────────────

/** What the model client knows about the inference behind it. */
export interface ContextHints {
  /** The model's context window, in tokens. */
  contextWindow?: number;
  /** Measured (or estimated) prompt reading speed, tokens per second. */
  promptPerSecond?: number;
  /** A hosted provider (the Gateway): prompt reading is fast and cached
   * input is discounted, even when neither number is known. */
  hosted?: boolean;
}

export function parseContextProfile(value: unknown): ContextProfileName | undefined {
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (CONTEXT_PROFILES as readonly string[]).includes(word) ? word as ContextProfileName : undefined;
}

/** The automatic choice. A measured slow local model uses the smallest
 * profile that retained coding-task quality; its environment override can
 * restore lean for a model that behaves differently. Unknown speed stays
 * lean until the one-time measurement completes. */
export function selectContextProfile(hints: ContextHints): ContextProfileName {
  const window = hints.contextWindow && hints.contextWindow > 0 ? hints.contextWindow : undefined;
  const speed = hints.promptPerSecond && hints.promptPerSecond > 0 ? hints.promptPerSecond : undefined;
  if (speed !== undefined && speed < LEAN_BELOW_PROMPT_PER_SECOND && !hints.hosted) return 'minimal';
  if (window !== undefined && window <= LEAN_MAX_CONTEXT_WINDOW) return 'lean';
  if (speed !== undefined) return speed < LEAN_BELOW_PROMPT_PER_SECOND ? 'lean' : 'full';
  // Speed unknown: only a hosted model is known to read fast. A large window
  // alone says nothing about speed -- a CPU can run a 128K window, slowly.
  return hints.hosted ? 'full' : 'lean';
}

/** The environment override, then the session's setting, then the
 * automatic choice. An unrecognized override is ignored rather than fatal. */
export function resolveContextProfile(input: { hints: ContextHints; session?: string; env?: NodeJS.ProcessEnv }): ContextProfile {
  const forced = parseContextProfile((input.env ?? process.env)[CONTEXT_PROFILE_ENV]) ?? parseContextProfile(input.session);
  return PROFILES[forced ?? selectContextProfile(input.hints)];
}
