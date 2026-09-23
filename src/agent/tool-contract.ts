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
  onPlan?(entries: PlanEntry[]): void;
  net?: NetworkSeams;
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
