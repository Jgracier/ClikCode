/** Profiles vary instruction verbosity and skill catalogs. Every profile
 * defers large MCP catalogs and uses small, retrievable result pages.
 * The full transcript is retained; context-view.ts bounds individual requests
 * only when necessary, keeping fitting prefixes byte-stable. */
import type { ToolSpec } from './model-client.js';

export type ContextProfileName = 'minimal' | 'lean' | 'full';
const CONTEXT_PROFILES: readonly ContextProfileName[] = ['minimal', 'lean', 'full'];

/** Forces a profile for every turn in this process, over a session's own
 * setting and the automatic choice: an evaluation must be able to pin each
 * profile and know every turn ran under it. */
export const CONTEXT_PROFILE_ENV = 'CLIKCODE_CONTEXT_PROFILE';

interface ContextProfile {
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

const MCP_EAGER_TOKENS = 1_500;
const TOOL_OUTPUT_BYTES = 8 * 1024;

/** Skills listed and description length. Lean's 20 x 150 chars is at most
 * ~850 tokens; full's 50 x 250 at most ~3,300, cached after the first step;
 * minimal's 10 x 80 at most ~250 -- a small model rarely picks a skill, and
 * an unlisted one is still found by name (skills.ts). */
const SKILLS = {
  minimal: { maxListedSkills: 10, skillDescriptionChars: 80 },
  lean: { maxListedSkills: 20, skillDescriptionChars: 150 },
  full: { maxListedSkills: 50, skillDescriptionChars: 250 },
} as const;

/** Windows at or below this get lean whatever the speed: a smaller catalog leaves room
 * for the task in a 32K window. 32K is also the
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
  task: 'Start a read-only research sub-agent. It sees none of this conversation: give it a self-contained prompt. Its answer includes a trace path.',
  agent: 'Delegate a self-contained coding task to an agent with local tools and this conversation\'s permissions.',
  web_fetch: 'Fetch a public http(s) URL and return its content as text.',
  web_search: 'Search the web; returns titles, URLs and snippets.',
  search_conversations: 'Search the user\'s other ClikCode conversations; returns matching chats with snippets and anchors.',
  read_conversation: 'Read another conversation\'s messages around an anchor, or its latest turns.',
  active_conversations: 'What the user\'s other conversations are doing now.',
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
    name: 'minimal', mcpEagerSchemaTokens: MCP_EAGER_TOKENS, toolOutputBytes: TOOL_OUTPUT_BYTES,
    ...SKILLS.minimal, toolUsageGuidance: false, shapeSpecs: minimalSpecs,
  },
  lean: {
    name: 'lean', mcpEagerSchemaTokens: MCP_EAGER_TOKENS, toolOutputBytes: TOOL_OUTPUT_BYTES,
    ...SKILLS.lean, toolUsageGuidance: true, shapeSpecs: unchanged,
  },
  full: {
    name: 'full', mcpEagerSchemaTokens: MCP_EAGER_TOKENS, toolOutputBytes: TOOL_OUTPUT_BYTES,
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

/** The environment override, then a profile the caller already chose
 * (a parent turn passes its own), then the automatic choice. An
 * unrecognized override is ignored rather than fatal. */
export function resolveContextProfile(input: { hints: ContextHints; session?: string; env?: NodeJS.ProcessEnv }): ContextProfile {
  const forced = parseContextProfile((input.env ?? process.env)[CONTEXT_PROFILE_ENV]) ?? parseContextProfile(input.session);
  return PROFILES[forced ?? selectContextProfile(input.hints)];
}
