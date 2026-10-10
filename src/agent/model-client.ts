/** The seam between the agent loop and whatever supplies model intelligence:
 * one step in, one step out. Deliberately mirrors the vendor transports'
 * callback shape so the UI treats this as one more harness. */

import type { AiHarnessPermissionMode } from '../harness/definition.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { ToolDefinition, ToolRunResult } from './tool-contract.js';
import type { ContextHints, ContextProfileName } from './context-profile.js';
import type { PermissionRules } from './permissions.js';

export interface TokenUsage {
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
  reasoning?: number;
  costMicroUsd?: number;
}

/** An image the user attached, carried inline so a resumed conversation can
 * resend it after the original file has moved or gone. `data` is base64
 * without a `data:` prefix. */
export interface ImageInput {
  mimeType: string;
  data: string;
  /** The file it came from, for display and for clients that only name it. */
  name?: string;
}

export type ConversationItem =
  /** On a text item, `images` only ever rides on a user item, and only when the model client
   * said it accepts them; `text` still names the files, so a client that
   * cannot send pixels loses nothing by ignoring the field. */
  | { type: 'text'; role: 'user' | 'assistant'; text: string; images?: readonly ImageInput[] }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  /** `images` are what the tool showed the model (read_file on a picture);
   * `output` still describes them in words for a client that cannot see. */
  | { type: 'tool_result'; id: string; name: string; output: string; isError?: boolean; images?: readonly ImageInput[] }
  | { type: 'summary'; text: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelStepRequest {
  system: string;
  items: readonly ConversationItem[];
  tools: readonly ToolSpec[];
  /** `none`: the tools stay declared (a history holding tool calls needs
   * them -- Anthropic rejects the request otherwise) but the model may not
   * call one this step. */
  toolChoice?: 'none';
  signal?: AbortSignal;
  onTextDelta(text: string): void;
  onReasoningDelta?(text: string): void;
  /** A tool call as it is being written: everything streamed for it so far.
   * `id` is the one the finished call carries in `toolCalls`, so a row
   * opened from this is the row the call settles. */
  onToolCallDelta?(call: StreamingToolCall): void;
  /** The model the server says is answering, as soon as it says so (the
   * Gateway's first frame), with the window it serves when known. */
  onServedModel?(model: string, contextWindow?: number): void;
}

export interface StreamingToolCall {
  id: string;
  name: string;
  /** The JSON arguments received so far, possibly cut mid-value. */
  arguments: string;
}

export interface ModelToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Set when the model's arguments were not a JSON object. The loop answers
   * the call with this instead of running it, so the model hears that its
   * JSON was broken rather than that some required field is missing. */
  argumentsError?: string;
}

export interface ModelStepResult {
  text: string;
  toolCalls: ModelToolCall[];
  stopReason: string;
  usage: TokenUsage;
  servedModel?: string;
  contextWindow?: number;
}

export interface ModelClient {
  step(request: ModelStepRequest): Promise<ModelStepResult>;
  /** True when the model can see images sent as `ImageInput`s. Without it
   * the loop does not read attached images into the transcript at all. */
  readonly acceptsImages?: boolean;
  /** What is known up front about the inference behind this client (its
   * window, how fast it reads prompts, whether it is hosted). The loop picks
   * the session's context profile from it (context-profile.ts). */
  readonly contextHints?: ContextHints;
}

export type HarnessErrorKind = 'quota' | 'auth' | 'other';

export type PlanEntry = { content: string; status: 'pending' | 'in_progress' | 'completed' };

/** The turn's usage so far, where its context stands, and why the latest
 * model step stopped (`length` is an answer cut off at its output limit). */
export type UsageReport = TokenUsage & { contextTokens?: number; contextWindow?: number; servedModel?: string; contextProfile?: ContextProfileName; stopReason?: string };

/** Optional pre/post tool interception. A pre hook may only veto (it can
 * never widen permissions); a post hook may only rewrite what the model sees. */
/** What every hook call is told; `signal` is the turn's, and cancelling it
 * stops a hook that is still running. */
export interface HookInfo { sessionId: string; cwd: string; signal?: AbortSignal }

interface HarnessHooks {
  preToolUse?(call: ModelToolCall, info: HookInfo): Promise<{ deny?: string } | void> | { deny?: string } | void;
  postToolUse?(call: ModelToolCall, result: ToolRunResult, info: HookInfo): Promise<{ output?: string } | void> | { output?: string } | void;
  /** May refuse the prompt (`block`, shown to the user) or add context to it. */
  userPromptSubmit?(prompt: string, info: HookInfo): Promise<{ block?: string; context?: string } | void>;
  /** Context for a conversation's first turn (`startup`) or its first after a restart (`resume`). */
  sessionStart?(info: HookInfo & { source: 'startup' | 'resume' }): Promise<{ context?: string } | void>;
  /** May keep the agent working when it would finish (`continueWith` is given to the model). */
  stop?(info: HookInfo & { stopHookActive: boolean }): Promise<{ continueWith?: string } | void>;
  /** The same, for a sub-agent about to hand its answer back to its parent. */
  subagentStop?(info: HookInfo & { stopHookActive: boolean; agentId: string; agentType: string; agentTranscriptPath: string }): Promise<{ continueWith?: string } | void>;
  /** Before the conversation is compacted. Watches only. */
  preCompact?(info: HookInfo & { trigger: 'auto' | 'manual' }): Promise<void>;
  /** The agent is waiting on the user: an approval, or a question it ended its turn on. Watches only. */
  notification?(info: HookInfo & { message: string; notificationType: 'permission_prompt' | 'idle_prompt' }): Promise<void>;
}

export interface GatewayHarnessTurnInput {
  sessionId: string;
  cwd: string;
  /** The Gateway agent's instructions (context.ts agentInstructions), when the conversation runs as one. */
  agentInstructions?: string;
  addDirs?: readonly string[];
  prompt: string;
  images?: readonly string[];
  permissionMode: AiHarnessPermissionMode;
  /** The mode as it stands NOW, read before every tool call: a change the user
   * makes mid-turn (ask -> bypass while a turn is running) applies to the rest
   * of that turn, not only the next one. Absent = `permissionMode` throughout. */
  currentPermissionMode?: () => Promise<AiHarnessPermissionMode | undefined>;
  planMode?: boolean;
  modelClient: ModelClient;
  /** Before each model step. A returned client is the one that step calls.
   * `'switch'` ends the loop: the user moved the conversation onto an
   * account this agent does not run, and the caller continues it there. */
  modelClientForStep?: () => Promise<ModelClient | 'switch' | undefined>;
  signal?: AbortSignal;
  /** e.g. ~/.clikcode — always injected, never derived from the real home. */
  stateDir: string;
  /** Where the user-level AGENTS.md lives. Defaults to `stateDir`. */
  userConfigDir?: string;
  /** Home directory used for `~` expansion and the write-deny list.
   * Defaults to os.homedir(); tests inject a temp dir. */
  homeDir?: string;
  maxSteps?: number;
  /** Default context window when the model client reports none. */
  contextWindow?: number;
  /** The session's own context profile setting. CLIKCODE_CONTEXT_PROFILE
   * still overrides it; absent, the profile is chosen from the model
   * client's hints (context-profile.ts). */
  contextProfile?: ContextProfileName;
  onResponseDelta?: (text: string, mode?: 'append' | 'replace') => void;
  onActivity?: (event: HarnessActivityEvent) => void;
  onPhase?: (phase: string) => void;
  /** Answering 'always' means "and remember this": the caller offered `rule`
   *  and the agent persists it before proceeding. Returning a plain boolean
   *  stays valid, so an approver that cannot remember anything is unchanged. */
  onApproval?: (title: string, detail?: string, rule?: string, preview?: import('../tui/render/approval-block.js').ApprovalPreview) => Promise<boolean | 'always'>;
  onSteerReady?: (handler?: (text: string) => Promise<void>) => void;
  onUsage?: (usage: UsageReport) => void;
  onPlan?: (entries: PlanEntry[]) => void;
  /** Fired when the user approves a plan and plan mode switches off mid-turn,
   * so the caller can stop passing `planMode: true` on later turns. */
  onPlanModeExit?: (plan: string) => void;
  /** MCP / skills plug in here later. */
  extraTools?: readonly ToolDefinition[];
  hooks?: HarnessHooks;
  /** The turn's allow rules, shared by reference with its sub-agents so an
   * "always" given anywhere applies to the rest of the turn. Read from the
   * workspace's settings when absent. */
  permissionRules?: { current: PermissionRules };
  /** Replaces the built-in tool set (tests, restricted embeddings). */
  tools?: readonly ToolDefinition[];
  /** Network seams for web_fetch; tests inject fakes. */
  net?: NetworkSeams;
  /** Set when this turn is a `task` sub-agent's: `system` replaces the built-in
   * prompt, the conversation goes to `transcriptFile`, and the turn cannot
   * start sub-agents of its own. `parentSessionId` and `kind` name it to a
   * SubagentStop hook. */
  subagent?: { system: string; transcriptFile: string; checkpoint?: { sessionId: string; turnId: string }; parentSessionId?: string; kind?: 'research' | 'work' };
  /** When the conversation has a swarm, a `task` call asks this before the
   * same-model sub-agent. Null keeps that sub-agent. */
  swarmDelegate?: (request: { prompt: string; description?: string; callId: string; signal?: AbortSignal; model?: string }) => Promise<ToolRunResult | null>;
  /** Models with usage left, shown on the task tool while swarm is on. */
  swarmModelNote?: string;
}

export interface GatewayHarnessTurnResult {
  text: string;
  nativeSessionId: string;
  isError?: boolean;
  errorKind?: HarnessErrorKind;
  /** Server-advised wait before retrying a quota failure, in seconds. */
  retryAfter?: number;
  usage: TokenUsage;
  steps: number;
  /** Why the loop ended. */
  stopReason: 'completed' | 'max-steps' | 'no-progress' | 'model-error' | 'account-switch';
  /** The context profile the turn ran under, so usage can be attributed to it. */
  contextProfile?: ContextProfileName;
}

export interface ResolvedAddress { address: string; family: 4 | 6 }

export interface PinnedResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array>;
}

/** GET unless stated: web_search POSTs to Tavily's API and DuckDuckGo's search form. */
export interface PinnedRequestOptions {
  signal?: AbortSignal;
  headers: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
}

export interface NetworkSeams {
  lookup?(hostname: string): Promise<ResolvedAddress[]>;
  /** Performs ONE request (no redirect following) against the already
   * vetted address, so a DNS answer cannot change between check and use. */
  request?(url: URL, pinned: ResolvedAddress, options: PinnedRequestOptions): Promise<PinnedResponse>;
}
