/** Wiring between ClikCode's local agent loop and the Gateway.
 *
 * The endpoint this talks to says what the split is, in its own header: the
 * coding-agent loop runs LOCALLY, and `/api/clikcode/v1/turn` supplies model
 * intelligence and nothing else. It is stateless -- one request is one model
 * step -- it never executes a tool, and the calls the model makes come back as
 * frames for this machine to run.
 *
 * So the loop, the tools, the permission prompts, the file checkpoints and the
 * conversation store are all here (gateway-harness/), and this module is the
 * seam: it turns a ClikCode session into a GatewayHarnessTurnInput, and turns
 * the loop's callbacks back into the prompter's own transcript rows.
 */
import type { McpServerSpec } from '../agent/mcp/config.js';
import { stdout as output } from 'node:process';
import { ModelClientError } from '../agent/models/gateway-client.js';
import { runGatewayHarnessTurn } from '../agent/run-turn.js';
import { mcpToolsForTurn } from '../agent/mcp/manager.js';
import { hooksForWorkspace, toolHooksFrom } from '../agent/hooks.js';
import type { GatewayHarnessTurnResult, ModelClient, TokenUsage, UsageReport } from '../agent/model-client.js';
import { turnStopReason, type TurnUsage } from '../harness/protocol/turn-usage.js';
import type { HarnessActivityEvent as GatewayActivityEvent } from '../harness/prompter.js';
import { GATEWAY_HARNESS_COMMAND, toolCategory } from '../harness/protocol/tools.js';
import { stateDirectory } from '../session/store/paths.js';
import { loadIndex } from '../session/state/index-file.js';
import type { AiHarnessPermissionMode } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import type { HarnessTurnObserver } from '../harness/events/turn-observer.js';
import type { TurnObserver } from '../turn/observer.js';

/** The gateway's own refusals, as opposed to a turn that genuinely failed.
 * 503 CLIKCODE_DISABLED is the documented administrator kill switch, and a 404
 * is a deployment that predates the endpoint. Both mean "this route cannot
 * serve a harness turn right now", which the caller answers by falling back. */
export function gatewayHarnessUnavailable(error: unknown): boolean {
  if (!(error instanceof ModelClientError)) return false;
  return error.statusCode === 404 || error.code === 'CLIKCODE_DISABLED';
}

interface GatewayHarnessSessionTurn extends HarnessTurnObserver {
  session: HarnessSession;
  prompt: string;
  prompter?: TurnObserver;
  /** Applied to each streamed delta before anyone sees it (drive passes the
   * title filter); undefined or '' holds it back. */
  responseFilter?: (text: string, mode: 'append' | 'replace') => string | undefined;
  /** Servers the route brings beside the user's own (the Gateway's ClikDeploy server). */
  mcpServers?: readonly McpServerSpec[];
  signal?: AbortSignal;
  images?: readonly string[];
  /** Whatever supplies the model step: the Gateway or ClikCode Local, as
   * modelClientForSession (agent/models/for-session.ts) chose for the route. */
  modelClient: ModelClient;
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
export async function runGatewayHarnessSessionTurn(
  input: GatewayHarnessSessionTurn,
): Promise<GatewayHarnessTurnResult> {
  const { session, prompter, modelClient } = input;
  // The gateway picks the model and the effort; what it cannot pick is how
  // much this machine lets the agent do without asking, because that is a
  // decision about the user's own filesystem. It stays local, and `ask` is
  // the setting that prompts rather than the one that assumes.
  const permissionMode: AiHarnessPermissionMode = session.permissionMode ?? 'ask';
  const stateDir = stateDirectory();
  // The user's MCP servers, the same ones `clikcode mcp add` gave every
  // harness. One that is down is named here rather than silently missing.
  const mcp = await mcpToolsForTurn(stateDir, input.signal, input.mcpServers ?? []);
  for (const note of mcp.notes) prompter?.activity(note);
  // The user's Claude Code tool hooks, so they run whichever lane serves the
  // turn; a workspace's own only once the user trusts it.
  const workspace = session.workspace ?? process.cwd();
  const hookConfig = await hooksForWorkspace({
    cwd: workspace, stateDir,
    ...(prompter ? { ask: (title: string, detail: string) => prompter.approval(title, detail) } : {}),
    notice: (message) => { if (prompter) prompter.activity(message); else process.stderr.write(`${message}\n`); },
  });
  const hooks = toolHooksFrom(hookConfig, (message) => prompter?.activity(message));
  return runGatewayHarnessTurn({
    sessionId: session.id,
    cwd: workspace,
    prompt: input.prompt,
    ...(hooks ? { hooks } : {}),
    permissionMode,
    // /permissions writes the index from the user's terminal while this turn
    // runs in the worker: read the mode back before each tool call so a switch
    // (ask -> bypass) applies to the rest of this turn.
    currentPermissionMode: async () => (await loadIndex())?.sessions.find((item) => item.id === session.id)?.permissionMode,
    modelClient,
    stateDir,
    ...(mcp.tools.length ? { extraTools: mcp.tools } : {}),
    ...(session.contextProfile ? { contextProfile: session.contextProfile } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.images?.length ? { images: input.images } : {}),
    onResponseDelta: (text, mode) => {
      // The same title filter the vendor path streams through: the tag a
      // first turn asks the model to open with never reaches the screen, and
      // so never outranks the stripped answer when the turn is saved.
      const visible = input.responseFilter ? input.responseFilter(text, mode ?? 'append') : text;
      if (!visible) return;
      input.onResponseDelta?.(visible, mode);
      prompter?.response(visible, mode);
    },
    onActivity: (event) => {
      // The loop reports its own tool names; classify them here so a gateway
      // row is coloured and animated by what it does exactly as a local
      // harness's row is. One standard, both routes.
      // The loop already stamps a category from the tool's class. The label
      // is often the command itself (`$ git status`), which is not a tool name,
      // so classifying the label would miss the run — or worse, call `ls` a
      // search. Only fill in what the loop did not already know.
      const category = event.category ?? toolCategory(event.label, undefined, Boolean(event.diff), GATEWAY_HARNESS_COMMAND);
      const classified = category && !event.category ? { ...event, category } : event;
      input.onActivity?.(classified as never);
      prompter?.activityEvent(classified as never);
    },
    onPhase: (phase) => {
      // The loop announces every model step as 'thinking' before calling it.
      if (phase === 'thinking') input.onStepStart?.();
      prompter?.phase(phase);
    },
    onPlan: (entries) => prompter?.setPlan(entries),
    // Per model step, as it happens: the loop's running total and where the
    // context stands, in the shape every harness reports.
    onUsage: (report) => {
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
    ...(prompter ? { onApproval: async (title: string, detail?: string, rule?: string) => (await prompter.approval(title, detail, undefined, rule)) ?? false } : {}),
    ...(input.onSteerReady ? { onSteerReady: input.onSteerReady } : {}),
  });
}

/** Human-readable reason a gateway harness turn could not run, for the
 * activity row that explains the fallback rather than hiding it. */
export function gatewayHarnessFallbackNotice(error: unknown): string {
  if (error instanceof ModelClientError && error.code === 'CLIKCODE_DISABLED') {
    return 'the gateway coding agent is disabled by an administrator; using the platform assistant, which cannot read local files';
  }
  return 'this gateway does not serve coding-agent turns yet; using the platform assistant, which cannot read local files';
}

