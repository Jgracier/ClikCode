/** Wiring between ClikCode's local agent loop and the ClikDeploy Gateway.
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
 *
 * Before this existed, a gateway session ran `/api/assistant/chat` instead --
 * the platform assistant, which cannot see this machine's files. That is why
 * /review and /init used to refuse on the gateway route.
 */
import { stdout as output } from 'node:process';
import {
  GatewayModelClient, ModelClientError, runGatewayHarnessTurn,
  type GatewayHarnessTurnResult, type HarnessActivityEvent as GatewayActivityEvent,
} from './gateway-harness/index.js';
import { GATEWAY_HARNESS_COMMAND, toolCategory } from './native-harness-protocol.js';
import { stateDirectory } from './session-store.js';
import type { AiHarnessPermissionMode, HarnessPrompter, HarnessSession } from './types.js';
import type { HarnessTurnObserver } from './harness-turn-observer.js';

/** The gateway's own refusals, as opposed to a turn that genuinely failed.
 * 503 CLIKCODE_DISABLED is the documented administrator kill switch, and a 404
 * is a deployment that predates the endpoint. Both mean "this route cannot
 * serve a harness turn right now", which the caller answers by falling back. */
export function gatewayHarnessUnavailable(error: unknown): boolean {
  if (!(error instanceof ModelClientError)) return false;
  return error.statusCode === 404 || error.code === 'CLIKCODE_DISABLED';
}

export interface GatewayHarnessSessionTurn extends HarnessTurnObserver {
  session: HarnessSession;
  prompt: string;
  baseUrl: string;
  apiKey: string;
  version: string;
  prompter?: HarnessPrompter;
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
      prompter?.response?.(text, mode);
    },
    onActivity: (event) => {
      // The loop reports its own tool names; classify them here so a gateway
      // row is coloured and animated by what it does exactly as a local
      // harness's row is. One standard, both routes.
      const category = toolCategory(event.label, undefined, Boolean((event as { diff?: unknown }).diff), GATEWAY_HARNESS_COMMAND);
      const classified = category ? { ...event, category } : event;
      input.onActivity?.(classified as never);
      prompter?.activityEvent?.(classified as never);
    },
    onPhase: (phase) => { (prompter as { phase?: (p: string) => void } | undefined)?.phase?.(phase); },
    onPlan: (entries) => { (prompter as { setPlan?: (e: unknown) => void } | undefined)?.setPlan?.(entries); },
    // No prompter means a headless run; a turn that cannot ask must not
    // silently act, so an unattended approval is a refusal.
    onApproval: async (title, detail) => (prompter?.approval ? prompter.approval(title, detail) : false),
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

/** Writes one line to stdout for a headless run, where there is no prompter
 * to put an activity row in. */
export function writeGatewayNotice(text: string): void {
  output.write(`${text}\n`);
}
