/** Wiring between ClikCode's own coding agent and the model behind it.
 *
 * The agent loop runs LOCALLY (agent/run-turn.ts): the tools, the permission
 * prompts, the file checkpoints and the conversation store are all on this
 * machine. The Gateway supplies model intelligence and nothing else, through
 * its OpenAI-compatible API (`POST {baseUrl}/v1/chat/completions`, one
 * request per model step; agent/models/for-session.ts): it never executes a
 * tool, and the calls the model makes stream back for this machine to run.
 * ClikCode Local plugs a local model server in at the same seam.
 *
 * This module turns a ClikCode session into a AgentTurnInput, and the
 * loop's callbacks back into the prompter's own transcript rows.
 */
import type { ApprovalPreview } from '../tui/render/approval-block.js';
import type { McpServerSpec } from '../agent/mcp/config.js';
import { runAgentLoop } from '../agent/run-turn.js';
import { mcpToolsForTurn } from '../agent/mcp/manager.js';
import { hooksForWorkspace, toolHooksFrom } from '../agent/hooks.js';
import type { AgentTurnInput, AgentTurnResult, ModelClient, TokenUsage, UsageReport } from '../agent/model-client.js';
import { turnStopReason, type TurnUsage } from '../harness/protocol/turn-usage.js';
import type { HarnessActivityEvent as AgentActivityEvent } from '../harness/prompter.js';
import { GATEWAY_HARNESS_COMMAND, toolCategory } from '../harness/protocol/tools.js';
import { stateDirectory } from '../session/store/paths.js';
import { diagnostic } from '../runtime/lifecycle-log.js';
import type { AiHarnessPermissionMode } from '../harness/definition.js';
import { sessionSandboxMode } from '../agent/sandbox.js';
import type { HarnessSession } from '../session/model.js';
import type { HarnessTurnObserver } from '../harness/events/turn-observer.js';
import type { TurnObserver } from '../turn/observer.js';

interface AgentSessionTurnInput extends HarnessTurnObserver, Pick<AgentTurnInput, 'onRemembered' | 'onSteersUndelivered'> {
  session: HarnessSession;
  prompt: string;
  prompter?: TurnObserver;
  /** Servers the route brings beside the user's own (the Gateway's ClikDeploy server). */
  mcpServers?: readonly McpServerSpec[];
  /** The Gateway agent's instructions, when the conversation runs as one. */
  agentInstructions?: string;
  signal?: AbortSignal;
  images?: readonly string[];
  /** Whatever supplies the model step: the Gateway or ClikCode Local, as
   * modelClientForSession (agent/models/for-session.ts) chose for the route. */
  modelClient: ModelClient;
  /** The mode as the user has it now: the worker's live settings. */
  currentPermissionMode?: () => Promise<AiHarnessPermissionMode | undefined>;
  modelClientForStep?: () => Promise<ModelClient | 'switch' | undefined>;
}

/** The agent loop's usage in the shape every harness reports. Cost arrives
 * in micro-dollars; the context estimate is the loop's own, taken the way it
 * decides when to compact. */
export function agentTurnUsage(report: TokenUsage & Partial<UsageReport>): TurnUsage {
  const usage: TurnUsage = {};
  if (report.input !== undefined) usage.input = report.input;
  if (report.output !== undefined) usage.output = report.output;
  if (report.cached !== undefined) usage.cacheRead = report.cached;
  if (report.cacheWrite !== undefined) usage.cacheWrite = report.cacheWrite;
  if (report.reasoning !== undefined) usage.reasoning = report.reasoning;
  if (report.costMicroUsd !== undefined) usage.costUsd = report.costMicroUsd / 1_000_000;
  if (report.contextWindow !== undefined) usage.contextWindow = report.contextWindow;
  if (report.contextTokens !== undefined) usage.contextUsed = report.contextTokens;
  const stopReason = turnStopReason(report.stopReason);
  if (stopReason) usage.stopReason = stopReason;
  return usage;
}

/** One turn of ClikCode's own coding agent, run on this machine. Named for
 * the Gateway, where it began; ClikCode Local sessions run it too, with a
 * different model client. */
export async function runAgentSessionTurn(
  input: AgentSessionTurnInput,
): Promise<AgentTurnResult> {
  const { session, prompter, modelClient } = input;
  // The gateway picks the model and the effort; what it cannot pick is how
  // much this machine lets the agent do without asking, because that is a
  // decision about the user's own filesystem. It stays local, and `ask` is
  // the setting that prompts rather than the one that assumes.
  const permissionMode: AiHarnessPermissionMode = session.permissionMode ?? 'ask';
  const stateDir = stateDirectory();
  // The user's MCP servers, the same ones `clikcode mcp add` gave every
  // harness. One that is down or needs a sign-in is simply not offered: the
  // manager logs why, and `/mcp` lists what needs a sign-in.
  const mcp = await mcpToolsForTurn(stateDir, input.signal, input.mcpServers ?? []);
  // The user's Claude Code tool hooks, so they run whichever lane serves the
  // turn; a workspace's own only once the user trusts it.
  const workspace = session.workspace ?? process.cwd();
  const hookConfig = await hooksForWorkspace({
    cwd: workspace, stateDir,
    ...(prompter ? { ask: (title: string, detail: string) => prompter.approval(title, detail) } : {}),
    notice: (message) => diagnostic('hooks.untrusted', message),
  });
  const hooks = toolHooksFrom(hookConfig, (message) => diagnostic('hooks.note', message));
  let servedModel: string | undefined;
  const publishActivity = (event: AgentActivityEvent): void => {
    const category = event.category ?? toolCategory(event.label, undefined, Boolean(event.diff), GATEWAY_HARNESS_COMMAND);
    const classified = category && !event.category ? { ...event, category } : event;
    input.onActivity?.(classified as never);
    prompter?.activityEvent(classified as never);
  };
  return runAgentLoop({
    sessionId: session.id,
    cwd: workspace,
    ...(input.agentInstructions ? { agentInstructions: input.agentInstructions } : {}),
    prompt: input.prompt,
    ...(hooks ? { hooks } : {}),
    permissionMode,
    // Plan mode (Settings): research only until the user approves a plan.
    planMode: session.planMode === true,
    ...(input.onPlanModeExit ? { onPlanModeExit: input.onPlanModeExit } : {}),
    ...(input.onPlanModeEnter ? { onPlanModeEnter: input.onPlanModeEnter } : {}),
    // A switch (ask -> bypass) while the turn runs applies to its next tool call: the
    // caller's live settings, pushed by the worker (turn/live-settings.ts).
    ...(input.currentPermissionMode ? { currentPermissionMode: input.currentPermissionMode } : {}),
    ...(sessionSandboxMode(session.sandbox) === 'workspace' ? { sandbox: 'workspace' as const } : {}),
    modelClient,
    ...(input.modelClientForStep ? { modelClientForStep: input.modelClientForStep } : {}),
    stateDir,
    ...(mcp.tools.length ? { extraTools: mcp.tools } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.images?.length ? { images: input.images } : {}),
    onResponseDelta: (text, mode) => {
      if (!text) return;
      input.onResponseDelta?.(text, mode);
      prompter?.response(text, mode);
    },
    onActivity: publishActivity,
    onPhase: (phase) => prompter?.phase(phase),
    onPlan: (entries) => prompter?.setPlan(entries),
    // Per model step, as it happens: the loop's running total and where the
    // context stands, in the shape every harness reports.
    onUsage: (report) => {
      if (report.servedModel && report.servedModel !== servedModel) { servedModel = report.servedModel; input.onServedModel?.(servedModel); }
      const usage = agentTurnUsage(report);
      input.onUsage?.(usage);
      prompter?.setTurnUsage(usage);
    },
    // No prompter means a headless run: no approver is attached, so what
    // would ask is refused -- and the model is told no one could be asked,
    // not that the user said no. Told "the user declined", a model stops to
    // ask what they would prefer; told the truth, it carries on without.
    // The gateway path runs ClikCode's OWN agent, so a rule can be
    // remembered here: the third answer is passed straight through.
    ...(prompter ? { onApproval: async (title: string, detail?: string, rule?: string, preview?: ApprovalPreview) => (await prompter.approval(title, detail, preview, rule)) ?? false } : {}),
    ...(input.onSteerReady ? { onSteerReady: input.onSteerReady } : {}),
    ...(input.onSteersUndelivered ? { onSteersUndelivered: input.onSteersUndelivered } : {}),
    ...(input.onRemembered ? { onRemembered: input.onRemembered } : {}),
  });
}
