/** What a tool is: the context it runs in, what it may return, and the
 * helper that declares one. */

import type { FileCheckpointStore } from './file-checkpoints.js';
import type { HarnessSessionState } from './session-state.js';
import type { ImageInput, NetworkSeams, PlanEntry } from './model-client.js';

export interface ToolContext {
  cwd: string;
  addDirs: readonly string[];
  sessionId: string;
  turnId: string;
  /** A coding child writes into its parent's undo checkpoint. */
  checkpoint?: { sessionId: string; turnId: string };
  stateDir: string;
  homeDir: string;
  signal?: AbortSignal;
  checkpoints: FileCheckpointStore;
  /** Per-session memory: read-before-edit tracking, background shells, plan mode. */
  session: HarnessSessionState;
  /** Identity of the tool call being executed (spill files, shell ids). */
  callId?: string;
  emitOutput?(chunk: string): void;
  /** Bytes of output the model will be given (context.ts toolOutputCap).
   * A tool that can say where it stopped should stop here itself rather than
   * have its middle cut out by the loop. */
  outputCap?: number;
  onPlan?(entries: PlanEntry[]): void;
  net?: NetworkSeams;
  /** The model answering this step can see images (ModelClient.acceptsImages). */
  acceptsImages?: boolean;
  /** The bash tool's OS sandbox (sandbox.ts), resolved by the caller from
   * the session's setting. Absent = off. */
  sandbox?: import('./sandbox.js').SandboxMode;
  /** Runs a `task` sub-agent under this call. Absent inside a sub-agent. */
  runSubagent?(request: SubagentCall): Promise<ToolRunResult>;
  /** This turn's background coding agents. Absent inside a sub-agent. */
  agents?: import('./background-agents.js').BackgroundAgents;
}

/** What a tool asks of a sub-agent; the loop adds the call id and signal. */
export interface SubagentCall {
  prompt: string;
  description?: string;
  model?: string;
  kind?: 'research' | 'work';
  /** A plugin's agent type (`subagent_type`): its prompt joins the
   * sub-agent's, and its tool list narrows the kind's tools. */
  agentType?: { name: string; prompt: string; tools?: readonly string[] };
  /** A coding sub-agent in its own git worktree, on its own branch. */
  isolation?: 'worktree';
  /** Started in the background: outlives the call, not the turn. */
  background?: true;
  /** Hands over the running sub-agent's steering handler (agent_send). */
  onSteerReady?: (handler?: (text: string) => Promise<void>) => void;
}

export interface ToolRunResult {
  output: string;
  isError?: boolean;
  /** Pictures for the model to see with the result; `output` says what they are. */
  images?: ImageInput[];
  diff?: import('./line-diff.js').FileDiff[];
  /** A finished command's exit code, shown on its row. */
  exitCode?: number;
  /** Replaces the tool's own label on the activity row once the call ends.
   * A swarm clerk uses it so the row keeps the provider it ran on. */
  activityLabel?: string;
  /** Set when another provider ran the call. The row animates under that name. */
  swarm?: import('../harness/prompter.js').HarnessActivityEvent['swarm'];
}

type ToolClass = 'read' | 'write' | 'exec' | 'network' | 'meta';

export interface ToolDefinition<A = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  class: ToolClass;
  /** Set on tools an MCP server provides: which server, and its own name for
   * the tool. Lets their schemas be deferred until loaded (mcp/deferred.ts). */
  mcp?: { server: string; tool: string; core?: true };
  label(args: A): string;
  /** True when this call may run alongside the other concurrent calls of its
   * step although its class is not `read`: it touches nothing they can see
   * (a coding sub-agent in its own worktree). Given unvalidated args. */
  concurrent?(args: A): boolean;
  /** Filesystem paths this call touches; drives confinement and deny checks. */
  paths?(args: A): string[];
  /** Human-readable preview (diff) shown in the approval prompt. Must not mutate. */
  /** What the call would change, for its approval: the same file hunks its
   * result reports, with the real path and line numbers. */
  preview?(args: A, ctx: ToolContext): Promise<import('./line-diff.js').FileDiff[] | undefined>;
  /** What the call would do, in words, for its approval (an MCP call's
   * server, tool and arguments). */
  describe?(args: A): Promise<string>;
  run(args: A, ctx: ToolContext): Promise<ToolRunResult>;
}

/** Registries hold the erased form; args are schema-validated before `run`,
 * which is what makes narrowing to the tool's own arg type sound. */
export function defineTool<A>(definition: ToolDefinition<A>): ToolDefinition {
  return definition as unknown as ToolDefinition;
}
