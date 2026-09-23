/** The seam between the agent loop and whatever supplies model intelligence:
 * one step in, one step out. Deliberately mirrors the vendor transports'
 * callback shape so the UI treats this as one more harness. */

import type { AiHarnessPermissionMode } from '../harness/definition.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { ToolDefinition, ToolRunResult } from './tool-contract.js';

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

type UsageReport = TokenUsage & { contextTokens?: number; contextWindow?: number; servedModel?: string };

/** Optional pre/post tool interception. A pre hook may only veto (it can
 * never widen permissions); a post hook may only rewrite what the model sees. */
interface HarnessHooks {
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
