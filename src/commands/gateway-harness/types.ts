/** Public contracts of the ClikCode gateway harness: a local coding-agent
 * loop for routes where the server supplies only model intelligence. The
 * turn input deliberately mirrors the vendor transports' callback seam
 * (codex-app-server.ts, acp-client.ts) so the UI treats this as one more
 * harness. */
import type { AiHarnessPermissionMode, HarnessActivityEvent } from '../types.js';
import type { FileCheckpointStore } from './file-checkpoints.js';
import type { HarnessSessionState } from './session-state.js';

export type { AiHarnessPermissionMode, HarnessActivityEvent };

export interface TokenUsage {
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
  reasoning?: number;
  costMicroUsd?: number;
}

export type ConversationItem =
  | { type: 'text'; role: 'user' | 'assistant'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; output: string; isError?: boolean }
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
  signal?: AbortSignal;
  onTextDelta(text: string): void;
  onReasoningDelta?(text: string): void;
}

export interface ModelToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
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
}

export type HarnessErrorKind = 'quota' | 'auth' | 'other';

export type PlanEntry = { content: string; status: 'pending' | 'in_progress' | 'completed' };

export type UsageReport = TokenUsage & { contextTokens?: number; contextWindow?: number; servedModel?: string };

/** Optional pre/post tool interception. A pre hook may only veto (it can
 * never widen permissions); a post hook may only rewrite what the model sees. */
export interface HarnessHooks {
  preToolUse?(call: ModelToolCall, info: { sessionId: string; cwd: string }): Promise<{ deny?: string } | void> | { deny?: string } | void;
  postToolUse?(call: ModelToolCall, result: ToolRunResult, info: { sessionId: string; cwd: string }): Promise<{ output?: string } | void> | { output?: string } | void;
}

export interface GatewayHarnessTurnInput {
  sessionId: string;
  cwd: string;
  addDirs?: readonly string[];
  prompt: string;
  images?: readonly string[];
  permissionMode: AiHarnessPermissionMode;
  planMode?: boolean;
  modelClient: ModelClient;
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
  onResponseDelta?: (text: string, mode?: 'append' | 'replace') => void;
  onActivity?: (event: HarnessActivityEvent) => void;
  onPhase?: (phase: string) => void;
  onApproval?: (title: string, detail?: string) => Promise<boolean>;
  onSteerReady?: (handler?: (text: string) => Promise<void>) => void;
  onUsage?: (usage: UsageReport) => void;
  onPlan?: (entries: PlanEntry[]) => void;
  /** Fired when the user approves a plan and plan mode switches off mid-turn,
   * so the caller can stop passing `planMode: true` on later turns. */
  onPlanModeExit?: (plan: string) => void;
  /** MCP / skills plug in here later. */
  extraTools?: readonly ToolDefinition[];
  hooks?: HarnessHooks;
  /** Replaces the built-in tool set (tests, restricted embeddings). */
  tools?: readonly ToolDefinition[];
  /** Network seams for web_fetch; tests inject fakes. */
  net?: NetworkSeams;
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
  stopReason: 'completed' | 'max-steps' | 'no-progress' | 'model-error';
}

export interface ResolvedAddress { address: string; family: 4 | 6 }

export interface PinnedResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array>;
}

export interface NetworkSeams {
  lookup?(hostname: string): Promise<ResolvedAddress[]>;
  /** Performs ONE request (no redirect following) against the already
   * vetted address, so a DNS answer cannot change between check and use. */
  request?(url: URL, pinned: ResolvedAddress, options: { signal?: AbortSignal; headers: Record<string, string> }): Promise<PinnedResponse>;
}

export interface ToolContext {
  cwd: string;
  addDirs: readonly string[];
  sessionId: string;
  turnId: string;
  stateDir: string;
  homeDir: string;
  signal?: AbortSignal;
  checkpoints: FileCheckpointStore;
  /** Per-session memory: read-before-edit tracking, background shells, plan mode. */
  session: HarnessSessionState;
  /** Identity of the tool call being executed (spill files, shell ids). */
  callId?: string;
  emitOutput?(chunk: string): void;
  onPlan?(entries: PlanEntry[]): void;
  net?: NetworkSeams;
}

export interface ToolRunResult {
  output: string;
  isError?: boolean;
  diff?: { removed: string[]; added: string[] };
}

export type ToolClass = 'read' | 'write' | 'exec' | 'network' | 'meta';

export interface ToolDefinition<A = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  class: ToolClass;
  label(args: A): string;
  /** Filesystem paths this call touches; drives confinement and deny checks. */
  paths?(args: A): string[];
  /** Human-readable preview (diff) shown in the approval prompt. Must not mutate. */
  preview?(args: A, ctx: ToolContext): Promise<string | undefined>;
  run(args: A, ctx: ToolContext): Promise<ToolRunResult>;
}

/** Registries hold the erased form; args are schema-validated before `run`,
 * which is what makes narrowing to the tool's own arg type sound. */
export function defineTool<A>(definition: ToolDefinition<A>): ToolDefinition {
  return definition as unknown as ToolDefinition;
}

export const TURN_CANCELLED_CODE = 'ERR_TURN_CANCELLED';

export function turnCancelledError(): Error & { code: string } {
  return Object.assign(new Error('Stopped'), { code: TURN_CANCELLED_CODE });
}

export function isTurnCancelled(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === TURN_CANCELLED_CODE;
}
