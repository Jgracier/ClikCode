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
import { stdout as output } from 'node:process';
import { GatewayModelClient, ModelClientError } from '../agent/models/gateway-client.js';
import { runGatewayHarnessTurn } from '../agent/run-turn.js';
import type { GatewayHarnessTurnResult } from '../agent/model-client.js';
import type { HarnessActivityEvent as GatewayActivityEvent } from '../harness/prompter.js';
import { GATEWAY_HARNESS_COMMAND, toolCategory } from '../harness/protocol/tools.js';
import { stateDirectory } from '../session/store/paths.js';
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
  baseUrl: string;
  apiKey: string;
  version: string;
  prompter?: TurnObserver;
  signal?: AbortSignal;
  images?: readonly string[];
  /** Injected by tests; production uses the real gateway client. */
  modelClient?: ConstructorParameters<typeof GatewayModelClient>[0] extends never ? never : Parameters<typeof runGatewayHarnessTurn>[0]['modelClient'];
}

/** One gateway turn, run as a real coding agent on this machine. */
export async function runGatewayHarnessSessionTurn(
  input: GatewayHarnessSessionTurn,
): Promise<GatewayHarnessTurnResult> {
  const { session, prompter } = input;
  const modelClient = input.modelClient ?? new GatewayModelClient({
    baseUrl: input.baseUrl, apiKey: input.apiKey, version: input.version, sessionId: session.id,
  });
  // The gateway picks the model and the effort; what it cannot pick is how
  // much this machine lets the agent do without asking, because that is a
  // decision about the user's own filesystem. It stays local, and `ask` is
  // the setting that prompts rather than the one that assumes.
  const permissionMode: AiHarnessPermissionMode = session.permissionMode ?? 'ask';
  return runGatewayHarnessTurn({
    sessionId: session.id,
    cwd: session.workspace ?? process.cwd(),
    prompt: input.prompt,
    permissionMode,
    modelClient,
    stateDir: stateDirectory(),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.images?.length ? { images: input.images } : {}),
    onResponseDelta: (text, mode) => {
      input.onResponseDelta?.(text, mode);
      prompter?.response(text, mode);
    },
    onActivity: (event) => {
      // The loop reports its own tool names; classify them here so a gateway
      // row is coloured and animated by what it does exactly as a local
      // harness's row is. One standard, both routes.
      // The loop already stamps a category from the tool's class. The label
      // is often the command itself (`git status`), which is not a tool name,
      // so classifying the label would miss the run — or worse, call `ls` a
      // search. Only fill in what the loop did not already know.
      const category = event.category ?? toolCategory(event.label, undefined, Boolean(event.diff), GATEWAY_HARNESS_COMMAND);
      const classified = category && !event.category ? { ...event, category } : event;
      input.onActivity?.(classified as never);
      prompter?.activityEvent(classified as never);
    },
    onPhase: (phase) => prompter?.phase(phase),
    onPlan: (entries) => prompter?.setPlan(entries),
    // No prompter means a headless run; a turn that cannot ask must not
    // silently act, so an unattended approval is a refusal.
    // The gateway path runs ClikCode's OWN agent, so a rule can be
    // remembered here: the third answer is passed straight through.
    onApproval: async (title, detail, rule) => (await prompter?.approval(title, detail, undefined, rule)) ?? false,
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

