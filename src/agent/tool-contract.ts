/** What a tool is: the context it runs in, what it may return, and the
 * helper that declares one. */

import type { FileCheckpointStore } from './file-checkpoints.js';
import type { HarnessSessionState } from './session-state.js';
import type { NetworkSeams, PlanEntry } from './model-client.js';

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
  /** Bytes of output the model will be given (context.ts toolOutputCap).
   * A tool that can say where it stopped should stop here itself rather than
   * have its middle cut out by the loop. */
  outputCap?: number;
  onPlan?(entries: PlanEntry[]): void;
  net?: NetworkSeams;
  /** Runs a `task` sub-agent under this call. Absent inside a sub-agent. */
  runSubagent?(request: { prompt: string; description?: string }): Promise<ToolRunResult>;
}

export interface ToolRunResult {
  output: string;
  isError?: boolean;
  diff?: { removed: string[]; added: string[] };
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
